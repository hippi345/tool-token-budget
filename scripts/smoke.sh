#!/usr/bin/env bash
# smoke:real — comprehensive functional smoke tests for tool-token-budget
# Exit codes: 0 = all pass, 1 = any failure

# Don't use set -e because we need to check exit codes of commands that should fail
cd "$(dirname "$0")/.."

echo "=== tool-token-budget smoke:real ==="
echo ""

# Setup
TEMP_OUT=$(mktemp -d)
trap "rm -rf $TEMP_OUT" EXIT

EXIT_CODE=0

# Helper to check exit code
check_exit() {
  local expected=$1
  local actual=$2
  local desc="$3"
  if [ "$actual" -eq "$expected" ]; then
    echo "✓ $desc (exit $actual)"
  else
    echo "✗ $desc (expected $expected, got $actual)"
    EXIT_CODE=1
  fi
}

# 1. Doctor
echo "--- 1. Doctor ---"
node dist/cli.js doctor
check_exit 0 $? "doctor exits 0"
echo ""

# 2. Analyze fixtures (tools-json)
echo "--- 2. Analyze fixtures ---"
node dist/cli.js analyze --tools-json fixtures/tools-tiny.json > /dev/null
check_exit 0 $? "analyze tools-tiny.json exits 0"

node dist/cli.js analyze --tools-json fixtures/tools-bloated.json > /dev/null
check_exit 0 $? "analyze tools-bloated.json exits 0"

node dist/cli.js analyze --tools-json fixtures/tools-enums.json > /dev/null
check_exit 0 $? "analyze tools-enums.json exits 0"
echo ""

# 3. Analyze live stub via mcp.json
echo "--- 3. Analyze live stub (mcp.json) ---"
node dist/cli.js analyze fixtures/mcp-with-secrets.json > /dev/null 2>&1
check_exit 0 $? "analyze mcp-with-secrets.json exits 0"

node dist/cli.js analyze fixtures/mcp-mixed.json > /dev/null 2>&1
check_exit 0 $? "analyze mcp-mixed.json exits 0 (warns + skips)"
echo ""

# 4. Emit artifacts
echo "--- 4. Emit artifacts ---"
node dist/cli.js emit --tools-json fixtures/tools-bloated.json --out "$TEMP_OUT/emit1" --keep-hot 3 > /dev/null
check_exit 0 $? "emit exits 0"

# Check three sibling artifacts exist
if [ -f "$TEMP_OUT/emit1/report.json" ] && \
   [ -f "$TEMP_OUT/emit1/defer-hints.json" ] && \
   [ -f "$TEMP_OUT/emit1/tool-token-budget.keep.json" ]; then
  echo "✓ three sibling artifacts exist (report.json, defer-hints.json, tool-token-budget.keep.json)"
else
  echo "✗ missing expected artifacts in $TEMP_OUT/emit1"
  ls -la "$TEMP_OUT/emit1" || true
  EXIT_CODE=1
fi
echo ""

# 5. --budget → exit 1 (over budget)
echo "--- 5. Budget enforcement ---"
node dist/cli.js analyze --tools-json fixtures/tools-bloated.json --budget 10 > /dev/null 2>&1
check_exit 1 $? "--budget 10 exits 1 (over budget)"

node dist/cli.js analyze --tools-json fixtures/tools-tiny.json --budget 1000 > /dev/null 2>&1
check_exit 0 $? "--budget 1000 exits 0 (under budget)"
echo ""

# 6. Bad flag → exit 2 (usage error)
echo "--- 6. Usage errors ---"
node dist/cli.js analyze --invalid-flag-xyz > /dev/null 2>&1
check_exit 2 $? "invalid flag exits 2"

node dist/cli.js nonexistent-command > /dev/null 2>&1
check_exit 2 $? "nonexistent command exits 2"
echo ""

# 7. Secrets redaction
echo "--- 7. Secrets redaction ---"
TEXT_REPORT=$(node dist/cli.js analyze fixtures/mcp-with-secrets.json 2>&1)
if echo "$TEXT_REPORT" | grep -q "should-never-appear-in-reports"; then
  echo "✗ text report leaked secret 'should-never-appear-in-reports'"
  EXIT_CODE=1
else
  echo "✓ text report: no secret leaks"
fi

JSON_REPORT=$(node dist/cli.js analyze fixtures/mcp-with-secrets.json --json 2>&1)
if echo "$JSON_REPORT" | grep -q "fake-api-key-do-not-leak"; then
  echo "✗ JSON report leaked secret 'fake-api-key-do-not-leak'"
  EXIT_CODE=1
else
  echo "✓ JSON report: no secret leaks"
fi

node dist/cli.js analyze fixtures/mcp-with-secrets.json --html "$TEMP_OUT/secrets.html" > /dev/null 2>&1
HTML_REPORT=$(cat "$TEMP_OUT/secrets.html")
if echo "$HTML_REPORT" | grep -q "SECRET_TOKEN"; then
  echo "✗ HTML report leaked secret 'SECRET_TOKEN'"
  EXIT_CODE=1
else
  echo "✓ HTML report: no secret leaks"
fi
echo ""

# 8. Remote entries don't crash
echo "--- 8. Remote entries (warn+skip) ---"
STDERR_OUT=$(node dist/cli.js analyze fixtures/mcp-mixed.json 2>&1 >/dev/null)
if echo "$STDERR_OUT" | grep -q "remote-sse"; then
  echo "✓ remote-sse warned+skipped"
else
  echo "✗ remote-sse not warned/skipped"
  EXIT_CODE=1
fi

if echo "$STDERR_OUT" | grep -q "remote-http"; then
  echo "✓ remote-http warned+skipped"
else
  echo "✗ remote-http not warned/skipped"
  EXIT_CODE=1
fi

# Should still exit 0 despite warnings
node dist/cli.js analyze fixtures/mcp-mixed.json > /dev/null 2>&1
check_exit 0 $? "mixed config with remotes exits 0"
echo ""

# Summary
echo "=== smoke:real complete ==="
if [ $EXIT_CODE -eq 0 ]; then
  echo "✓ All smoke tests passed"
else
  echo "✗ Some smoke tests failed"
fi

exit $EXIT_CODE
