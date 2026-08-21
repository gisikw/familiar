// Keyboard routing for tap-to-talk. This module is deliberately DOM-light so
// routing order can be tested without restty or a microphone.
//
// F8 is reserved for voice: it has no browser editing/navigation default and
// does not turn into a terminal control byte. The listener must be installed
// on window, in capture phase, BEFORE Restty is constructed. Calling
// stopImmediatePropagation (not merely stopPropagation) is essential because
// restty may also listen on window: stopPropagation does not stop later
// listeners on the same EventTarget.

export const VOICE_KEY_LABEL = "F8";

export function isVoiceToggle(event) {
  return event.key === "F8" &&
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function isEditableElement(element) {
  if (!element) return false;
  const tag = String(element.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
    element.isContentEditable === true;
}

function claim(event) {
  event.preventDefault();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  } else {
    event.stopPropagation();
  }
}

// deps: { getVoice(), getActiveElement(), isTerminalInput(element) }.
// Restty focuses a hidden textarea as its IME/key sink; that is part of the
// terminal, not a "real input" for the focus guard. Returns a disposer.
export function installVoiceKeyRouter(target, deps) {
  const getVoice = deps.getVoice;
  const getActiveElement = deps.getActiveElement || (() => null);
  const isTerminalInput = deps.isTerminalInput || (() => false);
  const onKeydown = (event) => {
    if (isVoiceToggle(event)) {
      // Real editing controls retain every key, including F8. This also makes
      // future modal/input additions safe without knowing their implementation.
      const activeElement = getActiveElement();
      if (isEditableElement(activeElement) && !isTerminalInput(activeElement)) return;
      claim(event); // reserve even during boot; never leak it to restty/PTY
      if (!event.repeat) getVoice()?.toggle();
      return;
    }

    const voice = getVoice();
    if (event.key === "Escape" && voice?.isActive()) {
      claim(event);
      voice.cancel();
    }
  };

  target.addEventListener("keydown", onKeydown, true);
  return () => target.removeEventListener("keydown", onKeydown, true);
}
