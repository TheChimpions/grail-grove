pub mod accept_authority;
pub mod delist;
pub mod eject;
pub mod initialize;
pub mod list;
pub mod propose_authority;
pub mod swap;
pub mod update_config;

// Glob re-exports let Anchor's #[program] macro find the generated
// __client_accounts_* modules at the crate root. Handlers are always called
// through fully-qualified paths so the `handler` name collision is harmless.
pub use accept_authority::*;
pub use delist::*;
pub use eject::*;
pub use initialize::*;
pub use list::*;
pub use propose_authority::*;
pub use swap::*;
pub use update_config::*;
