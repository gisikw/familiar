/// The inner tmux session currently presented by this viewer client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ViewerTarget {
    Presence,
    Terminal {
        id: String,
        socket: String,
        session: String,
    },
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

/// Runtime side of target replacement. Implementations must spawn the new
/// target before tearing down the old one.
pub trait TargetRuntime {
    type Error;

    fn replace(&mut self, target: &ViewerTarget) -> Result<(), Self::Error>;
}

impl App {
    pub fn target(&self) -> &ViewerTarget {
        &self.target
    }

    pub fn select(&mut self, target: ViewerTarget) {
        self.target = target;
    }

    /// Changes visible state only after the child replacement succeeds.
    pub fn switch_target<R: TargetRuntime>(
        &mut self,
        target: ViewerTarget,
        runtime: &mut R,
    ) -> Result<(), R::Error> {
        runtime.replace(&target)?;
        self.target = target;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeRuntime {
        result: Result<(), &'static str>,
        attempts: Vec<ViewerTarget>,
    }

    impl TargetRuntime for FakeRuntime {
        type Error = &'static str;

        fn replace(&mut self, target: &ViewerTarget) -> Result<(), Self::Error> {
            self.attempts.push(target.clone());
            self.result
        }
    }

    #[test]
    fn target_changes_only_after_successful_replacement() {
        let mut app = App::default();
        let target = ViewerTarget::Terminal {
            id: "one".into(),
            socket: "/run/golem.sock".into(),
            session: "worker-one".into(),
        };
        let mut failed = FakeRuntime {
            result: Err("spawn failed"),
            attempts: Vec::new(),
        };
        assert_eq!(
            app.switch_target(target.clone(), &mut failed),
            Err("spawn failed")
        );
        assert_eq!(app.target(), &ViewerTarget::Presence);
        assert_eq!(failed.attempts.as_slice(), std::slice::from_ref(&target));

        let mut succeeded = FakeRuntime {
            result: Ok(()),
            attempts: Vec::new(),
        };
        assert_eq!(app.switch_target(target.clone(), &mut succeeded), Ok(()));
        assert_eq!(app.target(), &target);
    }
}
