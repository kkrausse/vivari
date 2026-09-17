const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
fs.mkdirSync(require('node:os').tmpdir(), { recursive: true });
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'shell-quoting-'));
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
function run(command, scriptFile = false) {
  const script = root + '/command.sh';
  if (scriptFile) fs.writeFileSync(script, command);
  return new Promise((resolve, reject) => {
    const child = cp.spawn('sh', scriptFile ? [script] : ['-c', command], {
      cwd: root, env: { ...process.env, PATH: path.dirname(process.execPath) + ':' + process.env.PATH },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes.toString(); });
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end();
  });
}
(async () => {
  try {
    const source = root + '/source.tsx';
    const text = '<h1>Shell contract</h1>\n';
    fs.writeFileSync(source, text);
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    // Same five-line command shape as the real OpenCode shell gate: no flattening.
    const program = [
      `const bytes = require("node:fs").readFileSync(${JSON.stringify(source)});`,
      'const hash = require("node:crypto").createHash("sha256").update(bytes).digest("hex");',
      `if (hash !== "${hash}") throw new Error("Source SHA-256 mismatch");`,
      'if (!bytes.toString("utf8").includes("<h1>Shell contract</h1>")) throw new Error("Source heading mismatch");',
      'process.stdout.write("SHELL_SOURCE_CHECK_OK\\n");',
    ].join('\n');
    for (const scriptFile of [false, true]) {
      assert.deepEqual(await run('node -e ' + quote(program), scriptFile), {
        code: 0, signal: null, stdout: 'SHELL_SOURCE_CHECK_OK\n', stderr: '',
      });
    }
    const argsFile = root + '/args.cjs';
    fs.writeFileSync(argsFile, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const args = 'node ' + quote(argsFile) + ' ';
    const cases = [
      ["'first\nsecond' \"third\nfourth\"", ['first\nsecond', 'third\nfourth']],
      ["'#literal' word#suffix ''#joined # comment with an unmatched '\n", ['#literal', 'word#suffix', '#joined']],
      ["'single'\\''quote' \"double\\\"quote\" escaped\\ space", ["single'quote", 'double"quote', 'escaped space']],
      ["joined\\\nword \"double\\\nline\" 'literal\\\nline'", ['joinedword', 'doubleline', 'literal\\\nline']],
      ["\"keep\\q\" \"a\\\\b\" '' \"\"", ['keep\\q', 'a\\b', '', '']],
      ['trailing\\', ['trailing']],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(await run(args + input), { code: 0, signal: null, stdout: JSON.stringify(expected), stderr: '' });
    }
    assert.deepEqual(await run('false\n# comment\n'), { code: 1, signal: null, stdout: '', stderr: '' });
    assert.deepEqual(await run("false && echo skipped\necho 'first;still|one'\ntrue || echo skipped\necho second"), {
      code: 0, signal: null, stdout: 'first;still|one\nsecond\n', stderr: '',
    });
    assert.deepEqual(await run("echo 'a|b;#c' | cat\necho 'value # kept' > result.txt\ncat result.txt"), {
      code: 0, signal: null, stdout: 'a|b;#c\nvalue # kept\n', stderr: '',
    });
    const invalid = await run("echo 'unterminated");
    assert.equal(invalid.code, 2);
    assert.equal(invalid.stdout, '');
    assert.ok(invalid.stderr.length);
    console.log('SHELL_QUOTING_PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
