use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::github::{ApiError, GitHub, reset_at, sso_url};
use crate::state::unix_secs;

/// GitHub answers 200 even when it withheld what was asked for, and lists what
/// it left out beside the rest.
pub(crate) struct Reply<T> {
    pub(crate) data: T,
    pub(crate) withheld: Withheld,
}

pub(crate) struct Withheld {
    errors: Vec<Refusal>,
    sso_url: Option<String>,
}

#[derive(Deserialize)]
struct Refusal {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: String,
    path: Option<Vec<Value>>,
}

impl Refusal {
    fn path(&self) -> &[Value] {
        self.path.as_deref().unwrap_or_default()
    }
}

impl GitHub<'_> {
    pub(crate) fn graphql<T: Default + DeserializeOwned>(
        &self,
        query: &str,
        variables: Value,
    ) -> Result<Reply<T>, ApiError> {
        let (headers, body) = self.send(
            self.http
                .post(self.url("graphql")?)
                .header(ACCEPT, "application/json")
                .header(CONTENT_TYPE, "application/json")
                .body(json!({"query": query, "variables": variables}).to_string()),
        )?;
        decode(&headers, &body, unix_secs())
    }
}

fn decode<T: Default + DeserializeOwned>(
    headers: &HeaderMap,
    body: &[u8],
    now: u64,
) -> Result<Reply<T>, ApiError> {
    #[derive(Deserialize)]
    struct Envelope<T> {
        data: Option<T>,
        errors: Option<Vec<Refusal>>,
    }
    let Envelope { data, errors } =
        serde_json::from_slice::<Envelope<T>>(body).map_err(|_| ApiError::Unexpected)?;
    let errors = errors.unwrap_or_default();
    if errors
        .iter()
        .any(|error| matches!(error.kind.as_deref(), Some("RATE_LIMITED" | "RATE_LIMIT")))
    {
        return Err(ApiError::RateLimited {
            reset_at: reset_at(headers, now),
        });
    }
    let data = match data {
        Some(data) => data,
        None if errors.is_empty() => return Err(ApiError::Unexpected),
        None => T::default(),
    };
    Ok(Reply {
        data,
        withheld: Withheld {
            errors,
            sso_url: sso_url(headers),
        },
    })
}

fn gave_up(kind: &str) -> bool {
    matches!(kind, "RESOURCE_LIMITS_EXCEEDED" | "SERVICE_UNAVAILABLE")
        || kind.contains("TIMEOUT")
        || kind.contains("TIMED_OUT")
}

impl Withheld {
    /// Why GitHub left out `what`, which it would have answered under `root`.
    pub(crate) fn explain(self, root: &str, what: String) -> ApiError {
        let at_root = |error: &&Refusal| error.path().first().is_some_and(|step| step == root);
        let Some(error) = self.errors.iter().find(at_root).or(self.errors.first()) else {
            return ApiError::NotFound { what };
        };
        let message = error.message.clone();
        match (error.kind.as_deref(), self.sso_url) {
            (Some("NOT_FOUND"), _) => ApiError::NotFound { what },
            (Some("FORBIDDEN"), Some(url)) => ApiError::SsoRequired { url },
            (Some(kind), _) if !gave_up(kind) => ApiError::Forbidden { message },
            // GitHub types what it refuses, and seldom what it fails at.
            _ => ApiError::Unfinished { message },
        }
    }

    /// Whether GitHub left out a `field`, anywhere in the answer.
    pub(crate) fn field(&self, field: &str) -> bool {
        self.errors
            .iter()
            .any(|error| error.path().iter().any(|step| step == field))
    }
}
