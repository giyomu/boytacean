use std::{
    collections::VecDeque,
    fmt::{self, Display, Formatter},
    sync::{Arc, Mutex},
};

use boytacean::serial::SerialDevice;

const FIXED_REPLY: &[u8] = b"TEST OK\n";

pub type SerialReplyQueue = Arc<Mutex<VecDeque<u8>>>;

pub fn new_reply_queue() -> SerialReplyQueue {
    Arc::new(Mutex::new(VecDeque::new()))
}

pub struct NodeBridgeDevice {
    buffer: Vec<u8>,
    reply_queue: SerialReplyQueue,
}

impl NodeBridgeDevice {
    pub fn new(reply_queue: SerialReplyQueue) -> Self {
        Self {
            buffer: Vec::new(),
            reply_queue,
        }
    }

    fn flush_line(&mut self) {
        let message = String::from_utf8_lossy(&self.buffer).trim().to_string();
        println!("[NODE BRIDGE OUT] {}", message);
        if message.starts_with("ASK:") {
            let mut queue = self.reply_queue.lock().unwrap();
            queue.extend(FIXED_REPLY.iter().copied());
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
