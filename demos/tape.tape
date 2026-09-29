# VHS tape for Tool Token Budget demo GIF
# Run from repo root: vhs demos/tape.tape
# Output: demos/tool-token-budget-demo.gif

Output demos/tool-token-budget-demo.gif

Set Shell bash
Set FontSize 14
Set Width 1200
Set Height 600
Set Padding 10
Set Theme "Dracula"

Hide
Type "cd demos"
Enter
Type "alias tool-token-budget='node ../dist/cli.js'"
Enter
Type "clear"
Enter
Sleep 300ms
Show

Type "# Tool Token Budget Demo"
Sleep 500ms
Enter
Sleep 300ms

Type "# Offline fixture — not your home MCP config"
Sleep 300ms
Enter
Sleep 500ms

Type "tool-token-budget analyze --tools-json ../fixtures/tools-bloated.json"
Sleep 500ms
Enter
Sleep 3s

Type ""
Sleep 500ms
Enter
Type "# Emit proposals (keep 2 cheapest tools hot)"
Sleep 300ms
Enter
Sleep 500ms

Type "tool-token-budget emit --tools-json ../fixtures/tools-bloated.json --out /tmp/demo-out --keep-hot 2"
Sleep 500ms
Enter
Sleep 3s

Type ""
Sleep 500ms
Enter
Type "# Done — review report.json, defer-hints.json, and tool-token-budget.keep.json under --out"
Sleep 500ms
Enter
Sleep 1s
