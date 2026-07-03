//! veloci-buy Geyser plugin.
//!
//! Streams Solana account updates directly from the validator to the bot,
//! bypassing the latency of polling RPC. Each subscribed account update is
//! written as one line of JSON (NDJSON) to a socket the bot connects to:
//!
//!   * Unix:    a Unix Domain Socket at `socket_path` (lowest latency).
//!   * Fallback: a TCP listener at `tcp_addr` (cross-platform, e.g. on Windows).
//!
//! The bot consumes this stream via `src/services/ingestion/geyser-client.ts`
//! and falls back to RPC polling whenever the stream is unavailable.
//!
//! ## Why a thin transport
//!
//! Pool-account *decoding* (raw bytes → price) is pool-specific and changes as
//! DEX programs evolve, so it lives in the bot (TypeScript), not here. The
//! plugin's only job is to deliver raw account bytes with minimal latency and a
//! stable schema. That keeps the validator-side surface tiny and rarely
//! redeployed.

use crossbeam_channel::{bounded as sync_channel, Sender as SyncSender};
use std::thread;

use agave_geyser_plugin_interface::geyser_plugin_interface::{
    GeyserPlugin, GeyserPluginError, ReplicaAccountInfoVersions, Result as PluginResult,
};
use serde::Deserialize;

mod sink;
use sink::Sink;

/// Config loaded from the JSON file the validator points at via
/// `--geyser-plugin-config`. See `config.example.json`.
#[derive(Debug, Deserialize)]
struct PluginConfig {
    /// Path to this dylib (required by the validator loader; unused here).
    #[allow(dead_code)]
    libpath: Option<String>,
    #[allow(dead_code)]
    socket_path: Option<String>,
    /// TCP listen address, e.g. "127.0.0.1:9123" (fallback / Windows).
    tcp_addr: Option<String>,
    /// Base58 program owners to forward (e.g. Raydium / pump.fun). Empty = all.
    #[serde(default)]
    owner_allowlist: Vec<String>,
}

/// Raw account update sent from the Geyser thread to the background I/O thread.
struct AccountUpdateRaw {
    pubkey: [u8; 32],
    owner: [u8; 32],
    lamports: u64,
    slot: u64,
    write_version: u64,
    data: Vec<u8>,
}

#[derive(Default)]
pub struct VelociGeyserPlugin {
    sender: Option<SyncSender<AccountUpdateRaw>>,
    owner_allowlist_bytes: Vec<[u8; 32]>,
}

impl std::fmt::Debug for VelociGeyserPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VelociGeyserPlugin").finish()
    }
}

impl GeyserPlugin for VelociGeyserPlugin {
    fn name(&self) -> &'static str {
        "veloci-geyser-plugin"
    }

    fn on_load(&mut self, config_file: &str, _is_reload: bool) -> PluginResult<()> {
        let raw = std::fs::read_to_string(config_file)
            .map_err(|e| GeyserPluginError::ConfigFileReadError { msg: e.to_string() })?;
        let cfg: PluginConfig = serde_json::from_str(&raw)
            .map_err(|e| GeyserPluginError::ConfigFileReadError { msg: e.to_string() })?;

        let mut sink = open_sink(&cfg).map_err(|e| GeyserPluginError::Custom(Box::new(e)))?;

        let mut allowlist = Vec::new();
        for owner_b58 in &cfg.owner_allowlist {
            let decoded = bs58::decode(owner_b58)
                .into_vec()
                .map_err(|e| GeyserPluginError::ConfigFileReadError { msg: e.to_string() })?;
            if decoded.len() == 32 {
                let mut bytes = [0u8; 32];
                bytes.copy_from_slice(&decoded);
                allowlist.push(bytes);
            } else {
                return Err(GeyserPluginError::ConfigFileReadError {
                    msg: format!("Invalid owner pubkey length: {}", owner_b58),
                });
            }
        }
        self.owner_allowlist_bytes = allowlist;

        let (tx, rx) = sync_channel(10_000);
        self.sender = Some(tx);

        thread::Builder::new()
            .name("veloci-geyser-io".to_string())
            .spawn(move || {
                // rx.recv() blocks until a message is sent or sender disconnects
                for raw_update in rx {
                    let _ = sink.write_binary(
                        &raw_update.pubkey,
                        &raw_update.owner,
                        raw_update.lamports,
                        raw_update.slot,
                        raw_update.write_version,
                        &raw_update.data,
                    );
                }
                log::info!("veloci-geyser-plugin IO thread exiting");
            })
            .map_err(|e| GeyserPluginError::Custom(Box::new(e)))?;

        log::info!("veloci-geyser-plugin loaded");
        Ok(())
    }

    fn on_unload(&mut self) {
        // Dropping the sender gracefully terminates the background thread
        self.sender = None;
    }

    /// We only care about account state for price derivation.
    fn account_data_notifications_enabled(&self) -> bool {
        true
    }

    fn transaction_notifications_enabled(&self) -> bool {
        false
    }

    fn update_account(
        &self,
        account: ReplicaAccountInfoVersions,
        slot: u64,
        _is_startup: bool,
    ) -> PluginResult<()> {
        let (pubkey, owner, lamports, write_version, data) = match account {
            ReplicaAccountInfoVersions::V0_0_3(a) => {
                (a.pubkey, a.owner, a.lamports, a.write_version, a.data)
            }
            ReplicaAccountInfoVersions::V0_0_2(a) => {
                (a.pubkey, a.owner, a.lamports, a.write_version, a.data)
            }
            ReplicaAccountInfoVersions::V0_0_1(a) => {
                (a.pubkey, a.owner, a.lamports, a.write_version, a.data)
            }
        };

        if !self.owner_allowlist_bytes.is_empty() {
            if owner.len() != 32 {
                return Ok(());
            }
            let mut owner_array = [0u8; 32];
            owner_array.copy_from_slice(owner);
            if !self.owner_allowlist_bytes.contains(&owner_array) {
                return Ok(());
            }
        }

        if let Some(sender) = &self.sender {
            if sender.is_full() {
                return Ok(());
            }

            let mut pubkey_array = [0u8; 32];
            if pubkey.len() == 32 {
                pubkey_array.copy_from_slice(pubkey);
            } else {
                return Ok(());
            }

            let mut owner_array = [0u8; 32];
            owner_array.copy_from_slice(owner);

            let raw = AccountUpdateRaw {
                pubkey: pubkey_array,
                owner: owner_array,
                lamports,
                slot,
                write_version,
                data: data.to_vec(),
            };

            // Best-effort: a dropped consumer must never stall the validator.
            // If the channel is full, drop the update.
            let _ = sender.try_send(raw);
        }

        Ok(())
    }
}

fn open_sink(cfg: &PluginConfig) -> std::io::Result<Sink> {
    #[cfg(unix)]
    if let Some(path) = &cfg.socket_path {
        return Sink::unix(path);
    }
    if let Some(addr) = &cfg.tcp_addr {
        return Sink::tcp(addr);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidInput,
        "config must set socket_path (unix) or tcp_addr",
    ))
}


/// Entry point the validator calls to construct the plugin.
///
/// # Safety
/// Called once by the validator's plugin loader; returns an owned boxed trait
/// object that the validator takes responsibility for.
#[no_mangle]
#[allow(improper_ctypes_definitions)]
pub unsafe extern "C" fn _create_plugin() -> *mut dyn GeyserPlugin {
    let plugin = VelociGeyserPlugin::default();
    Box::into_raw(Box::new(plugin))
}
