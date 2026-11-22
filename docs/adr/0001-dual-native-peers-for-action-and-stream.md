# Dual Native Peers for Action and Stream

We run two isolated `OpenComputerUse` processes (`action-engine` and `stream-engine`) under separate socket namespaces rather than sharing a single native peer. Calling `get_app_state` with `include_ax: false` for 9fps Side-Pane Mini-Window streaming wipes `OpenComputerUse`'s internal element index table, so isolating stream capture onto its own peer preserves active Qualified Element Refs across concurrent model actions at the cost of one extra background helper process.
