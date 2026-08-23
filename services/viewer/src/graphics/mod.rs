use serde::{Deserialize, Serialize};

/// Semantic Kitty graphics actions emitted by the VT core. The eventual FFI
/// adapter owns escape parsing; viewer chrome only consumes these events.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct KittyGraphicsEvent {
    pub action: KittyAction,
    pub image_id: Option<u32>,
    pub placement_id: Option<u32>,
    pub columns: Option<u16>,
    pub rows: Option<u16>,
    /// Decoded image bytes, or opaque bytes for an operation the viewer does
    /// not yet interpret. Payload chunks may arrive in multiple events.
    pub payload: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum KittyAction {
    Transmit,
    TransmitAndDisplay,
    Place,
    Delete,
    Query,
    Unknown,
}

/// Presentation-side sink kept separate from the streaming terminal engine.
pub trait GraphicsSink {
    type Error;

    fn handle(&mut self, event: KittyGraphicsEvent) -> Result<(), Self::Error>;
    fn clear_child_state(&mut self) -> Result<(), Self::Error>;
}
