/// The inner tmux session currently presented by this viewer client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ViewerTarget {
    Presence,
    Agent(String),
}

/// Navigation state is deliberately local to one viewer process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct App {
    target: ViewerTarget,
}

impl Default for App {
    fn default() -> Self {
        Self {
            target: ViewerTarget::Presence,
        }
    }
}

impl App {
    pub fn target(&self) -> &ViewerTarget {
        &self.target
    }

    pub fn select(&mut self, target: ViewerTarget) {
        self.target = target;
    }
}
