use std::{
    collections::VecDeque,
    fmt::{self, Display, Formatter},
    sync::{mpsc, Arc, Mutex},
    thread,
};

use boytacean::serial::SerialDevice;
use serde::Deserialize;

const FALLBACK_REPLY: &[u8] = b"LINK ERROR\n";

pub type SerialReplyQueue = Arc<Mutex<VecDeque<u8>>>;

#[derive(Deserialize)]
struct BridgeResponse {
    reply: Option<String>,
}

pub fn new_reply_queue() -> SerialReplyQueue {
    Arc::new(Mutex::new(VecDeque::new()))
}

fn enqueue_reply(reply_queue: &SerialReplyQueue, reply: &str) {
    let mut bytes = reply.as_bytes().to_vec();
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    let mut queue = reply_queue.lock().unwrap();
    queue.extend(bytes);
}

fn enqueue_fallback(reply_queue: &SerialReplyQueue) {
    let mut queue = reply_queue.lock().unwrap();
    queue.extend(FALLBACK_REPLY.iter().copied());
}

fn worker_loop(url: String, receiver: mpsc::Receiver<String>, reply_queue: SerialReplyQueue) {
    while let Ok(message) = receiver.recv() {
        // println!("[NODE BRIDGE WORKER] received {message}");

        let prompt = if let Some(prompt) = message.strip_prefix("ASK:") {
            prompt.to_string()
        } else {
            message.clone()
        };

        println!("[NODE BRIDGE SEND] {message}");

        let result: Result<String, String> = (|| -> Result<String, String> {
            // one-shot agent per request so no pooled connection survives this iteration
            let agent = ureq::AgentBuilder::new()
                .max_idle_connections_per_host(0)
                .build();

            let response = agent
                .post(&url)
                .set("Content-Type", "application/json")
                .send_json(ureq::json!({
                    "message": message,
                    "prompt": prompt,
                }))
                .map_err(|err| format!("HTTP request failed: {err}"))?;

            let status = response.status();
            println!("[NODE BRIDGE HTTP] status {status}");

            let body: BridgeResponse = response
                .into_json()
                .map_err(|err| format!("JSON parse failed: {err}"))?;

            if status != 200 {
                Err(format!("HTTP status {status}"))
            } else {
                let reply = body.reply.unwrap_or_else(|| String::from("WAIT"));
                println!("[NODE BRIDGE IN] {reply}");
                Ok(reply)
            }
        })();

        // println!("[NODE BRIDGE SENT] {message}");

        match result {
            Ok(reply) => {
                println!("[NODE BRIDGE QUEUE] {reply}");
                enqueue_reply(&reply_queue, &reply);
            }
            Err(err) => {
                eprintln!("[NODE BRIDGE ERROR] {err}");
                enqueue_fallback(&reply_queue);
            }
        }
    }
    // println!("[NODE BRIDGE WORKER] channel closed");
}

pub struct NodeBridgeDevice {
    buffer: Vec<u8>,
    request_tx: mpsc::Sender<String>,
    reply_queue: SerialReplyQueue,
}

impl NodeBridgeDevice {
    pub fn new(reply_queue: SerialReplyQueue, node_url: String) -> Self {
        let (request_tx, request_rx) = mpsc::channel();
        let worker_queue = reply_queue.clone();
        thread::spawn(move || {
            // println!("[NODE BRIDGE WORKER] started");
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                worker_loop(node_url, request_rx, worker_queue);
            }));
            if result.is_err() {
                eprintln!("[NODE BRIDGE PANIC] worker thread panicked");
            }
        });

        Self {
            buffer: Vec::new(),
            request_tx,
            reply_queue,
        }
    }

    fn flush_line(&mut self) {
        let visible_bytes: Vec<u8> = self
            .buffer
            .iter()
            .copied()
            .filter(|&byte| byte != 0)
            .collect();

        if !visible_bytes.is_empty() {
            println!("[NODE BRIDGE RAW] {:02X?}", visible_bytes);
        }

        let message = String::from_utf8_lossy(&self.buffer)
            .trim_start_matches(|c: char| c == '\0' || c.is_ascii_control())
            .trim()
            .to_string();
        println!("[NODE BRIDGE OUT] {}", message);
        // println!("[NODE BRIDGE PREFIX] {}", message.starts_with("ASK:"));
        if message.starts_with("ASK:") {
            // println!("[NODE BRIDGE ENQUEUE] {message}");
            if let Err(err) = self.request_tx.send(message) {
                eprintln!("[NODE BRIDGE ERROR] failed to enqueue request: {err}");
                enqueue_fallback(&self.reply_queue);
            } else {
                // println!("[NODE BRIDGE ENQUEUED]");
            }
        }
        self.buffer.clear();
    }
}

impl SerialDevice for NodeBridgeDevice {
    fn send(&mut self) -> u8 {
        0xff
    }

    fn receive(&mut self, byte: u8) {
        if byte == b'\n' {
            self.flush_line();
        } else {
            self.buffer.push(byte);
        }
    }

    fn allow_slave(&self) -> bool {
        false
    }

    fn description(&self) -> String {
        String::from("Node Bridge")
    }

    fn state(&self) -> String {
        String::from("")
    }
}

impl Display for NodeBridgeDevice {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "Node Bridge")
    }
}
