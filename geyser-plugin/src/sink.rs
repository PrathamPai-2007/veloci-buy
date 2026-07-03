//! Output sink for the Geyser plugin: writes NDJSON lines to the bot.
//!
//! The plugin runs inside the validator's hot path, so writes must never block
//! it. We accept exactly one consumer (the bot) and, if it disconnects or is
//! slow, drop the connection rather than stall. The bot reconnects and resumes;
//! gaps are covered by its RPC polling fallback.

use std::io::Write;
use std::net::{TcpListener, TcpStream};


pub enum Sink {
    Tcp {
        listener: TcpListener,
        stream: Option<TcpStream>,
    },
    #[cfg(unix)]
    Unix {
        listener: std::os::unix::net::UnixListener,
        stream: Option<std::os::unix::net::UnixStream>,
    },
}

impl Sink {
    pub fn tcp(addr: &str) -> std::io::Result<Self> {
        let listener = TcpListener::bind(addr)?;
        listener.set_nonblocking(true)?;
        Ok(Sink::Tcp {
            listener,
            stream: None,
        })
    }

    #[cfg(unix)]
    pub fn unix(path: &str) -> std::io::Result<Self> {
        // Remove a stale socket file from a previous run.
        let _ = std::fs::remove_file(path);
        let listener = std::os::unix::net::UnixListener::bind(path)?;
        listener.set_nonblocking(true)?;
        Ok(Sink::Unix {
            listener,
            stream: None,
        })
    }

    /// Writes account update in a custom binary frame:
    /// [4 bytes Frame Length]
    /// [32 bytes Pubkey]
    /// [32 bytes Owner]
    /// [8 bytes Lamports]
    /// [8 bytes Slot]
    /// [8 bytes WriteVersion]
    /// [4 bytes Data Length]
    /// [N bytes Data]
    pub fn write_binary(
        &mut self,
        pubkey: &[u8; 32],
        owner: &[u8; 32],
        lamports: u64,
        slot: u64,
        write_version: u64,
        data: &[u8],
    ) -> std::io::Result<()> {
        match self {
            Sink::Tcp { listener, stream } => {
                if stream.is_none() {
                    if let Ok((s, _)) = listener.accept() {
                        s.set_nonblocking(false).ok();
                        s.set_write_timeout(Some(std::time::Duration::from_millis(500)))
                            .ok();
                        s.set_nodelay(true).ok();
                        *stream = Some(s);
                    }
                }
                if let Some(s) = stream {
                    let mut buf = Vec::with_capacity(4 + 32 + 32 + 8 + 8 + 8 + 4 + data.len());
                    let frame_len = (32 + 32 + 8 + 8 + 8 + 4 + data.len()) as u32;
                    buf.extend_from_slice(&frame_len.to_le_bytes());
                    buf.extend_from_slice(pubkey);
                    buf.extend_from_slice(owner);
                    buf.extend_from_slice(&lamports.to_le_bytes());
                    buf.extend_from_slice(&slot.to_le_bytes());
                    buf.extend_from_slice(&write_version.to_le_bytes());
                    buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
                    buf.extend_from_slice(data);

                    if s.write_all(&buf).is_err() {
                        *stream = None;
                    }
                }
            }
            #[cfg(unix)]
            Sink::Unix { listener, stream } => {
                if stream.is_none() {
                    if let Ok((s, _)) = listener.accept() {
                        s.set_nonblocking(false).ok();
                        s.set_write_timeout(Some(std::time::Duration::from_millis(500)))
                            .ok();
                        *stream = Some(s);
                    }
                }
                if let Some(s) = stream {
                    let mut buf = Vec::with_capacity(4 + 32 + 32 + 8 + 8 + 8 + 4 + data.len());
                    let frame_len = (32 + 32 + 8 + 8 + 8 + 4 + data.len()) as u32;
                    buf.extend_from_slice(&frame_len.to_le_bytes());
                    buf.extend_from_slice(pubkey);
                    buf.extend_from_slice(owner);
                    buf.extend_from_slice(&lamports.to_le_bytes());
                    buf.extend_from_slice(&slot.to_le_bytes());
                    buf.extend_from_slice(&write_version.to_le_bytes());
                    buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
                    buf.extend_from_slice(data);

                    if s.write_all(&buf).is_err() {
                        *stream = None;
                    }
                }
            }
        }
        Ok(())
    }
}
