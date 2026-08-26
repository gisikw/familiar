// restty 0.2.6 emits two DA1 replies for one DA1 query. A multiplexer consumes
// the first as its attach-time capability response, then treats the duplicate
// as keyboard input and forwards its printable tail to the application.
//
// Keep a one-for-one budget so every real DA1 query is answered, while an
// extra reply produced without a corresponding query never enters the PTY.
export class TerminalReplyGate {
  constructor() {
    this.da1Queries = 0;
    this.outputTail = "";
  }

  observeOutput(data) {
    const text = this.outputTail + data;
    const queries = text.match(/(?:\x1b\[|\x9b)0?c/g);
    this.da1Queries += queries?.length || 0;
    // Retain only an incomplete query prefix. Keeping the end of a complete
    // query would count it again when the next output frame arrives.
    const partial = text.match(/(?:\x1b(?:\[0?)?|\x9b0?)$/);
    this.outputTail = partial?.[0] || "";
  }

  allowInput(data) {
    if (!/^(?:\x1b\[|\x9b)\?[0-9;]*c$/.test(data)) return true;
    if (this.da1Queries === 0) return false;
    this.da1Queries--;
    return true;
  }
}
