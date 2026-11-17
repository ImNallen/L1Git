use crate::Host;
use crate::github::{self, Login, api_failure};
use crate::vault::keychain;
use crate::wire::{ErrorKind, Failure, GhProbe, Method};

impl Host {
    pub(crate) fn probe_gh(&self) -> GhProbe {
        self.gh.probe()
    }

    pub(crate) fn connect_gh(&self, login: Login) -> Result<(), Failure> {
        let writer = self.lock_writes();
        self.vault.open().map_err(keychain)?;
        let token = self.gh.token(&login)?;
        let verified = github::verify(self.http.client()?, self.endpoints.api(), Method::Gh, token)
            .map_err(api_failure)?;
        if verified.login() != &login {
            return Err(Failure::new(
                ErrorKind::GhAccountChanged {
                    expected: login.to_string(),
                    found: verified.login().to_string(),
                },
                format!(
                    "The GitHub CLI's sign-in belongs to {}, not {}. Check again in Settings › Hosts.",
                    verified.login(),
                    login
                ),
            ));
        }
        self.commit(&writer, verified)
    }

    /// Never revokes the token on GitHub: it is gh's token too, and revoking
    /// it would sign gh out.
    pub(crate) fn disconnect(&self) -> Result<(), Failure> {
        self.disconnect_and_clear_slot(&self.lock_writes())
    }

    pub(crate) fn verify(&self) -> Result<(), Failure> {
        let fetched = self.with_github(|github| github.user())?;
        let (account, access) = fetched.value;
        self.refresh(&self.lock_writes(), fetched.generation, account, access)
    }
}
