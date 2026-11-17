use serde::{Deserialize, Serialize};
use url::Url;

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

#[cfg(test)]
mod tests {
    use super::*;

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
