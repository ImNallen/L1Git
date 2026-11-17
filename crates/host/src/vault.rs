use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use keyring_core::{CredentialStore, Entry, Error};
use reqwest::header::HeaderValue;

use crate::github::ApiBase;
use crate::wire::{ErrorKind, Failure, KeychainProblem};

pub(crate) struct Token(String);

impl Token {
    pub(crate) fn parse(raw: &str) -> Option<Token> {
        let raw = raw.trim();
        let shaped = (1..=255).contains(&raw.len())
            && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        shaped.then(|| Token(raw.to_owned()))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    pub(crate) fn authorization(&self) -> HeaderValue {
        let mut value = HeaderValue::from_str(&format!("Bearer {}", self.0))
            .expect("a parsed token is ASCII letters, digits and underscores");
        value.set_sensitive(true);
        value
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(..)")
    }
}

pub(crate) trait Vault: Send + Sync {
    fn open(&self) -> Result<(), KeychainProblem>;
    fn read(&self, api: &ApiBase) -> Result<Option<Token>, KeychainProblem>;
    fn replace(&self, api: &ApiBase, token: &Token) -> Result<(), KeychainProblem>;
    fn delete_if_present(&self, api: &ApiBase) -> Result<(), KeychainProblem>;
}

pub(crate) struct SystemVault {
    service: String,
    store: OnceLock<Arc<CredentialStore>>,
    make: fn() -> keyring_core::Result<Arc<CredentialStore>>,
}

impl SystemVault {
    pub(crate) fn new(service: String) -> SystemVault {
        SystemVault {
            service,
            store: OnceLock::new(),
            make: platform_store,
        }
    }

    #[cfg(test)]
    pub(crate) fn over(
        service: &str,
        make: fn() -> keyring_core::Result<Arc<CredentialStore>>,
    ) -> SystemVault {
        SystemVault {
            service: service.to_owned(),
            store: OnceLock::new(),
            make,
        }
    }

    /// Cached only once it opens: the Linux store connects to D-Bus here, and
    /// a Secret Service that starts after L1 Git should still work.
    fn store(&self) -> Result<&Arc<CredentialStore>, KeychainProblem> {
        if let Some(store) = self.store.get() {
            return Ok(store);
        }
        let store = (self.make)().map_err(|_| KeychainProblem::Unavailable)?;
        Ok(self.store.get_or_init(|| store))
    }

    fn entry(&self, api: &ApiBase) -> Result<Entry, KeychainProblem> {
        self.store()?
            .build(&self.service, api.as_str(), None)
            .map_err(refused)
    }
}

impl Vault for SystemVault {
    fn open(&self) -> Result<(), KeychainProblem> {
        self.store().map(|_| ())
    }

    fn read(&self, api: &ApiBase) -> Result<Option<Token>, KeychainProblem> {
        match self.entry(api)?.get_password() {
            Ok(secret) => Ok(Token::parse(&secret)),
            Err(Error::NoEntry | Error::BadEncoding(_) | Error::BadDataFormat(..)) => Ok(None),
            Err(error) => Err(refused(error)),
        }
    }

    /// Deleting first makes this binary the item's creator, so a re-signed
    /// macOS build owns the item it wrote.
    fn replace(&self, api: &ApiBase, token: &Token) -> Result<(), KeychainProblem> {
        let entry = self.entry(api)?;
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => {}
            Err(error) => return Err(refused(error)),
        }
        entry.set_password(token.expose()).map_err(refused)
    }

    fn delete_if_present(&self, api: &ApiBase) -> Result<(), KeychainProblem> {
        match self.entry(api)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(refused(error)),
        }
    }
}

/// Once the store is open, a failed call is a locked keychain or a denied
/// prompt: macOS reports a denial as a platform failure, not as no access.
fn refused(_: Error) -> KeychainProblem {
    KeychainProblem::Locked
}

#[cfg(target_os = "macos")]
fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
    let store: Arc<CredentialStore> = apple_native_keyring_store::keychain::Store::new()?;
    Ok(store)
}

#[cfg(windows)]
fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
    let store: Arc<CredentialStore> = windows_native_keyring_store::Store::new()?;
    Ok(store)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
    let store: Arc<CredentialStore> = zbus_secret_service_keyring_store::Store::new()?;
    Ok(store)
}

#[derive(Default)]
pub(crate) struct MemoryVault(Mutex<HashMap<String, String>>);

impl MemoryVault {
    fn items(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Vault for MemoryVault {
    fn open(&self) -> Result<(), KeychainProblem> {
        Ok(())
    }

    fn read(&self, api: &ApiBase) -> Result<Option<Token>, KeychainProblem> {
        Ok(self
            .items()
            .get(api.as_str())
            .and_then(|secret| Token::parse(secret)))
    }

    fn replace(&self, api: &ApiBase, token: &Token) -> Result<(), KeychainProblem> {
        self.items()
            .insert(api.as_str().to_owned(), token.expose().to_owned());
        Ok(())
    }

    fn delete_if_present(&self, api: &ApiBase) -> Result<(), KeychainProblem> {
        self.items().remove(api.as_str());
        Ok(())
    }
}

pub(crate) fn keychain(problem: KeychainProblem) -> Failure {
    let message = match problem {
        KeychainProblem::Locked => {
            "L1 Git could not use the system keychain. Unlock it, or allow L1 Git when your system asks, then try again."
        }
        KeychainProblem::Unavailable => {
            "L1 Git needs a system keychain to keep your GitHub sign-in, and none is available. On Linux, start GNOME Keyring or KWallet, then try again."
        }
    };
    Failure::new(ErrorKind::Keychain { problem }, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use keyring_core::mock;

    fn api() -> ApiBase {
        ApiBase::parse("https://api.github.com/").unwrap()
    }

    fn mock_store() -> keyring_core::Result<Arc<CredentialStore>> {
        let store: Arc<CredentialStore> = mock::Store::new()?;
        Ok(store)
    }

    fn cred(entry: &Entry) -> &mock::Cred {
        entry.as_any().downcast_ref().unwrap()
    }

    fn failure() -> Box<dyn std::error::Error + Send + Sync> {
        "mock".into()
    }

    #[test]
    fn token_debug_is_redacted() {
        let token = Token::parse("gho_secret123\n").unwrap();
        assert_eq!(token.expose(), "gho_secret123");
        assert_eq!(format!("{token:?}"), "Token(..)");
        assert!(Token::parse("Error: <html>").is_none());
        assert!(Token::parse("").is_none());
    }

    #[test]
    fn system_vault_round_trips_and_maps_keyring_errors() {
        let vault = SystemVault::over("dev.l1.git.test", mock_store);
        let token = Token::parse("gho_one").unwrap();
        assert!(
            matches!(vault.read(&api()), Ok(None)),
            "no item reads as none"
        );
        assert_eq!(
            vault.delete_if_present(&api()),
            Ok(()),
            "deleting nothing succeeds"
        );
        vault.replace(&api(), &token).unwrap();
        vault
            .replace(&api(), &Token::parse("gho_two").unwrap())
            .unwrap();
        assert_eq!(
            vault.read(&api()).unwrap().unwrap().expose(),
            "gho_two",
            "replace overwrites an existing item"
        );

        let entry = vault.entry(&api()).unwrap();
        cred(&entry).set_error(Error::NoStorageAccess(failure()));
        assert_eq!(vault.read(&api()).err(), Some(KeychainProblem::Locked));
        cred(&entry).set_error(Error::PlatformFailure(failure()));
        assert_eq!(
            vault.replace(&api(), &token).err(),
            Some(KeychainProblem::Locked),
            "a denied macOS prompt is a platform failure"
        );

        entry.set_secret(&[0xff, 0xfe]).unwrap();
        assert!(
            matches!(vault.read(&api()), Ok(None)),
            "an undecodable item reads as missing"
        );
        entry.set_password("not a token").unwrap();
        assert!(matches!(vault.read(&api()), Ok(None)));
        assert!(keyring_core::get_default_store().is_none());
    }

    #[test]
    fn system_vault_without_a_store_is_unavailable() {
        let vault = SystemVault::over("dev.l1.git.test", || {
            Err(Error::PlatformFailure("no Secret Service".into()))
        });
        assert_eq!(vault.open(), Err(KeychainProblem::Unavailable));
        assert_eq!(vault.read(&api()).err(), Some(KeychainProblem::Unavailable));
        assert!(keyring_core::get_default_store().is_none());
    }
}
