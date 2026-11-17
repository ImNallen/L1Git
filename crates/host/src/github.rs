use std::io::Read;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap};
use reqwest::redirect::Policy;
use rustls_platform_verifier::BuilderVerifierExt;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::Host;
use crate::state::{CommitId, unix_secs};
use crate::vault::{Token, keychain};
use crate::wire::{Access, EndReason, ErrorKind, Failure, Method};

const BODY_CAP: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(crate) struct ApiBase(Url);

impl ApiBase {
    pub(crate) fn parse(raw: &str) -> Result<ApiBase, String> {
        let mut url = Url::parse(raw).map_err(|_| format!("{raw} is not a web address."))?;
        if url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(format!(
                "{raw} must be a plain address, without a user name, password, query or fragment."
            ));
        }
        match url.scheme() {
            "https" => {}
            "http" if loopback(&url) => {}
            _ => return Err(format!("{raw} must use https.")),
        }
        if !url.path().ends_with('/') {
            let path = format!("{}/", url.path());
            url.set_path(&path);
        }
        Ok(ApiBase(url))
    }

    pub(crate) fn is_loopback(&self) -> bool {
        loopback(&self.0)
    }

    pub(crate) fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

impl TryFrom<String> for ApiBase {
    type Error = String;

    fn try_from(value: String) -> Result<ApiBase, String> {
        ApiBase::parse(&value)
    }
}

impl From<ApiBase> for String {
    fn from(api: ApiBase) -> String {
        api.0.into()
    }
}

/// Where a host sends tokens: GitHub itself, or a loopback fixture.
#[derive(Clone, Debug)]
pub struct Endpoints {
    api: ApiBase,
}

impl Endpoints {
    pub fn github_com() -> Endpoints {
        Endpoints {
            api: ApiBase::parse("https://api.github.com/").expect("a fixed https address"),
        }
    }

    /// For fixture servers. Refuses every address that is not loopback.
    pub fn loopback(api: &str) -> Result<Endpoints, String> {
        let api = ApiBase::parse(api)?;
        if !api.is_loopback() {
            return Err(format!(
                "{} is not a loopback address. Use one such as http://127.0.0.1:8080/.",
                api.as_str()
            ));
        }
        Ok(Endpoints { api })
    }

    pub(crate) fn api(&self) -> &ApiBase {
        &self.api
    }
}

/// A GitHub login. It starts with a letter or digit, so it can never be read
/// as a gh flag. Compared without regard to case, as GitHub does.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Login(String);

impl Login {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Login {
    type Error = String;

    fn try_from(value: String) -> Result<Login, String> {
        let mut chars = value.chars();
        let valid = value.len() <= 100
            && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if valid {
            Ok(Login(value))
        } else {
            Err(format!("{value:?} is not a GitHub login."))
        }
    }
}

impl From<Login> for String {
    fn from(login: Login) -> String {
        login.0
    }
}

impl PartialEq for Login {
    fn eq(&self, other: &Login) -> bool {
        self.0.eq_ignore_ascii_case(&other.0)
    }
}

impl Eq for Login {}

impl std::fmt::Display for Login {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub(crate) struct Account {
    pub(crate) login: Login,
    pub(crate) id: u64,
}

pub(crate) struct Verified {
    token: Token,
    account: Account,
    access: Access,
    method: Method,
}

impl Verified {
    pub(crate) fn login(&self) -> &Login {
        &self.account.login
    }

    pub(crate) fn into_parts(self) -> (Token, Account, Access, Method) {
        (self.token, self.account, self.access, self.method)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn assume(token: &str, login: &str, id: u64, access: Access) -> Verified {
        Verified {
            token: Token::parse(token).unwrap(),
            account: Account {
                login: Login::try_from(login.to_owned()).unwrap(),
                id,
            },
            access,
            method: Method::Gh,
        }
    }
}

/// Built on first use, inside the blocking task, because a blocking reqwest
/// client panics when built in an async context.
pub(crate) struct Http {
    https_only: bool,
    client: OnceLock<Client>,
}

impl Http {
    pub(crate) fn new(https_only: bool) -> Http {
        Http {
            https_only,
            client: OnceLock::new(),
        }
    }

    pub(crate) fn client(&self) -> Result<&Client, Failure> {
        if let Some(client) = self.client.get() {
            return Ok(client);
        }
        let client = build(self.https_only).ok_or_else(|| {
            Failure::new(
                ErrorKind::Unreachable,
                "L1 Git could not set up a secure connection to GitHub. Restart L1 Git, then try again.",
            )
        })?;
        Ok(self.client.get_or_init(|| client))
    }
}

/// Names ring explicitly instead of installing a process-wide rustls provider,
/// which the updater decides on its own.
fn build(https_only: bool) -> Option<Client> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .ok()?
        .with_platform_verifier()
        .ok()?
        .with_no_client_auth();
    Client::builder()
        .tls_backend_preconfigured(tls)
        .user_agent(concat!("L1Git/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(Policy::none())
        .https_only(https_only)
        .build()
        .ok()
}

pub(crate) struct GitHub<'a> {
    http: &'a Client,
    api: &'a ApiBase,
    token: &'a Token,
}

pub(crate) enum ApiError {
    Unauthorized,
    RateLimited { reset_at: Option<u64> },
    Forbidden { message: String },
    Status(u16),
    Unreachable,
    Unexpected,
}

impl GitHub<'_> {
    fn get(&self, path: &str) -> Result<(HeaderMap, Vec<u8>), ApiError> {
        let url = self.api.0.join(path).map_err(|_| ApiError::Unexpected)?;
        let response = self
            .http
            .get(url)
            .header(ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header(AUTHORIZATION, self.token.authorization())
            .send()
            .map_err(|_| ApiError::Unreachable)?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let mut body = Vec::new();
        response
            .take(BODY_CAP)
            .read_to_end(&mut body)
            .map_err(|_| ApiError::Unreachable)?;
        match classify(status, &headers, &body, unix_secs()) {
            Some(error) => Err(error),
            None => Ok((headers, body)),
        }
    }

    pub(crate) fn user(&self) -> Result<(Account, Access), ApiError> {
        #[derive(Deserialize)]
        struct User {
            login: Login,
            id: u64,
        }
        let (headers, body) = self.get("user")?;
        let user: User = serde_json::from_slice(&body).map_err(|_| ApiError::Unexpected)?;
        let scopes = headers
            .get("x-oauth-scopes")
            .and_then(|value| value.to_str().ok());
        Ok((
            Account {
                login: user.login,
                id: user.id,
            },
            Access::from_scopes(scopes),
        ))
    }
}

fn classify(status: u16, headers: &HeaderMap, body: &[u8], now: u64) -> Option<ApiError> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
    };
    let retry_after = header("retry-after").and_then(|value| value.parse::<u64>().ok());
    let limited =
        status == 429 || retry_after.is_some() || header("x-ratelimit-remaining") == Some("0");
    match status {
        200..=299 => None,
        401 => Some(ApiError::Unauthorized),
        403 | 429 if limited => Some(ApiError::RateLimited {
            reset_at: retry_after
                .map(|after| now.saturating_add(after))
                .or_else(|| header("x-ratelimit-reset").and_then(|value| value.parse().ok())),
        }),
        403 => {
            #[derive(Deserialize)]
            struct Refusal {
                message: String,
            }
            let message = serde_json::from_slice::<Refusal>(body)
                .map(|refusal| refusal.message)
                .unwrap_or_else(|_| "GitHub refused the request.".to_owned());
            Some(ApiError::Forbidden { message })
        }
        _ => Some(ApiError::Status(status)),
    }
}

pub(crate) fn verify(
    http: &Client,
    api: &ApiBase,
    method: Method,
    token: Token,
) -> Result<Verified, ApiError> {
    let (account, access) = GitHub {
        http,
        api,
        token: &token,
    }
    .user()?;
    Ok(Verified {
        token,
        account,
        access,
        method,
    })
}

#[derive(Debug)]
pub(crate) struct Fetched<T> {
    pub(crate) value: T,
    pub(crate) generation: CommitId,
}

impl Host {
    pub(crate) fn with_github<T>(
        &self,
        read: impl FnOnce(&GitHub<'_>) -> Result<T, ApiError>,
    ) -> Result<Fetched<T>, Failure> {
        let api = self.endpoints.api();
        let generation = self
            .lock()
            .saved
            .get(api)
            .map(|connection| connection.generation)
            .ok_or_else(|| {
                Failure::new(
                    ErrorKind::NotConnected,
                    "L1 Git is not connected to GitHub. Sign in from Settings › Hosts.",
                )
            })?;
        let Some(token) = self.vault.read(api).map_err(keychain)? else {
            self.forget(&self.lock_writes(), generation, EndReason::TokenMissing);
            return Err(Failure::new(
                ErrorKind::SignedOut,
                "L1 Git's GitHub sign-in is no longer in the system keychain. Sign in again in Settings › Hosts.",
            ));
        };
        let github = GitHub {
            http: self.http.client()?,
            api,
            token: &token,
        };
        match read(&github) {
            Ok(value) => Ok(Fetched { value, generation }),
            Err(ApiError::Unauthorized) => {
                self.forget(&self.lock_writes(), generation, EndReason::Revoked);
                Err(Failure::new(
                    ErrorKind::SignedOut,
                    "GitHub no longer accepts L1 Git's sign-in. Sign in again in Settings › Hosts.",
                ))
            }
            Err(error) => Err(api_failure(error)),
        }
    }
}

pub(crate) fn api_failure(error: ApiError) -> Failure {
    match error {
        ApiError::Unauthorized => Failure::new(
            ErrorKind::Rejected,
            "GitHub did not accept the GitHub CLI's sign-in. Run gh auth login, then try again.",
        ),
        ApiError::RateLimited { reset_at } => {
            let wait = match reset_at.map(|at| at.saturating_sub(unix_secs()).div_ceil(60).max(1)) {
                Some(1) => "Try again in a minute.".to_owned(),
                Some(minutes) => format!("Try again in {minutes} minutes."),
                None => "Try again in a few minutes.".to_owned(),
            };
            Failure::new(
                ErrorKind::RateLimited { reset_at },
                format!("GitHub's rate limit for your account is used up. {wait}"),
            )
        }
        ApiError::Forbidden { message } => Failure::new(
            ErrorKind::GitHubFailed { http_status: 403 },
            format!("GitHub refused the request: {message}"),
        ),
        ApiError::Status(code) => Failure::new(
            ErrorKind::GitHubFailed { http_status: code },
            format!("GitHub answered with an error (HTTP {code}). Try again later."),
        ),
        ApiError::Unreachable => Failure::new(
            ErrorKind::Unreachable,
            "L1 Git could not reach GitHub. Check your connection, then try again.",
        ),
        ApiError::Unexpected => Failure::new(
            ErrorKind::GitHubFailed { http_status: 200 },
            "GitHub sent an answer L1 Git did not understand. Try again later.",
        ),
    }
}

#[cfg(test)]
mod tests {
    use reqwest::header::HeaderValue;

    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        pairs
            .iter()
            .map(|(name, value)| {
                (
                    reqwest::header::HeaderName::from_static(name),
                    HeaderValue::from_str(value).unwrap(),
                )
            })
            .collect()
    }

    fn kind(status: u16, pairs: &[(&'static str, &str)], body: &str) -> Option<ErrorKind> {
        classify(status, &headers(pairs), body.as_bytes(), 1_000)
            .map(|error| api_failure(error).kind)
    }

    #[test]
    fn classify_statuses() {
        assert_eq!(kind(200, &[], ""), None);
        assert_eq!(kind(401, &[], ""), Some(ErrorKind::Rejected));
        assert_eq!(
            kind(
                403,
                &[
                    ("x-ratelimit-remaining", "0"),
                    ("x-ratelimit-reset", "1700")
                ],
                r#"{"message":"API rate limit exceeded"}"#
            ),
            Some(ErrorKind::RateLimited {
                reset_at: Some(1700)
            })
        );
        assert_eq!(
            kind(429, &[("retry-after", "60")], ""),
            Some(ErrorKind::RateLimited {
                reset_at: Some(1060)
            })
        );
        let sso = classify(
            403,
            &HeaderMap::new(),
            br#"{"message":"Resource protected by organization SAML enforcement."}"#,
            0,
        )
        .map(api_failure)
        .unwrap();
        assert_eq!(sso.kind, ErrorKind::GitHubFailed { http_status: 403 });
        assert!(sso.message.contains("SAML enforcement"), "{}", sso.message);
        assert_eq!(
            kind(502, &[], "<html>"),
            Some(ErrorKind::GitHubFailed { http_status: 502 })
        );
    }

    #[test]
    fn api_base_rejects_plain_http_off_loopback() {
        for refused in [
            "http://api.github.com/",
            "https://user:pw@api.github.com/",
            "https://api.github.com/?x=1",
            "ftp://api.github.com/",
            "api.github.com",
        ] {
            assert!(ApiBase::parse(refused).is_err(), "{refused}");
        }
        assert_eq!(
            ApiBase::parse("http://127.0.0.1:1234").unwrap().as_str(),
            "http://127.0.0.1:1234/"
        );
        assert_eq!(
            ApiBase::parse("https://ghe.example.com/api/v3")
                .unwrap()
                .as_str(),
            "https://ghe.example.com/api/v3/"
        );
        assert!(Endpoints::loopback("http://[::1]:80/").is_ok());
        assert!(Endpoints::loopback("https://api.github.com/").is_err());
        let stored: Result<ApiBase, _> = serde_json::from_str(r#""http://example.com/""#);
        assert!(
            stored.is_err(),
            "a saved record cannot name plain http either"
        );
    }

    #[test]
    fn logins_cannot_be_flags_and_compare_without_case() {
        let login = |raw: &str| Login::try_from(raw.to_owned());
        assert!(login("-x").is_err());
        assert!(login("").is_err());
        assert!(login("octo cat").is_err());
        assert!(
            login("octo_acme").is_ok(),
            "managed-user logins have an underscore"
        );
        assert_eq!(login("Octo").unwrap(), login("octo").unwrap());
    }
}
