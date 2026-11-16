const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

/** A document request gets setup help; explicit MCP stream requests keep their transport. */
export function isSetupRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (['mcp-protocol-version', 'mcp-session-id', 'mcp-method'].some(header => request.headers.has(header))) return false;
  const accept = request.headers.get('accept')?.toLowerCase() ?? '';
  return !accept.includes('text/event-stream') || accept.includes('text/html');
}

export function renderSetupPage(endpoint: string): string {
  const url = escapeHtml(endpoint);
  const block = (id: string, text: string, label = 'Copy command'): string => `<div class="code-block"><pre><code id="${id}">${escapeHtml(text)}</code></pre><button class="copy-button" type="button" data-copy="${id}" aria-label="${label}">Copy <span aria-hidden="true">⧉</span></button></div>`;
  const link = (href: string, title: string): string => `<a class="doc-link" href="${href}" target="_blank" rel="noreferrer">${title} <span aria-hidden="true">↗</span></a>`;
  const fields = `<dl class="fields"><div><dt>Name</dt><dd>writing-scaffold</dd></div><div><dt>Transport</dt><dd>Streamable HTTP</dd></div><div><dt>Server URL</dt><dd class="url-value">${url}</dd></div><div><dt>Authentication</dt><dd>No sign-in</dd></div></dl>`;
  const piDocs = 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md';
  const claudeDocs = 'https://code.claude.com/docs/en/mcp';
  const claudeGuiDocs = 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp';
  const codexDocs = 'https://learn.chatgpt.com/docs/extend/mcp#connect-an-existing-mcp-server';
  const panels = [
    { id: 'pi-cli', agent: 'Pi', mode: 'Command line', intro: 'Run this in your terminal to make the library available across your projects.', content: `
      <ol class="steps"><li><h4>Add the server</h4>${block('pi-add', `pi mcp add writing-scaffold --url ${endpoint}`, 'Copy Pi add command')}</li>
      <li><h4>Check the connection</h4>${block('pi-check', 'pi mcp list', 'Copy Pi check command')}<p>Start Pi, or run <code>/reload</code> in an existing session. Open <code>/mcp</code> to see the server.</p></li></ol>
      ${link(piDocs, 'Pi setup reference')}` },
    { id: 'pi-gui', agent: 'Pi', mode: 'GUI & editor', intro: 'Pi uses a configuration file and an in-session server panel for visual setup.', content: `
      <ol class="steps"><li><h4>Open the configuration in your editor</h4><p>Open <code>~/.pi/agent/mcp.json</code>, or create it if it does not exist.</p></li>
      <li><h4>Add Writing Scaffold</h4><p>Merge this entry into <code>mcpServers</code>, keeping any servers you already have.</p>${block('pi-config', JSON.stringify({ mcpServers: { 'writing-scaffold': { url: endpoint } } }, null, 2), 'Copy Pi configuration')}</li>
      <li><h4>Save and reconnect</h4><p>Start Pi, or run <code>/reload</code>. Open <code>/mcp</code> and select <strong>writing-scaffold</strong> to inspect its connection and tools.</p></li></ol>
      ${link(piDocs, 'Pi configuration reference')}` },
    { id: 'claude-cli', agent: 'Claude', mode: 'Command line', intro: 'Add the server to Claude Code for your user account, across projects.', content: `
      <ol class="steps"><li><h4>Add the server</h4>${block('claude-add', `claude mcp add --transport http --scope user writing-scaffold ${endpoint}`, 'Copy Claude Code add command')}</li>
      <li><h4>Check the connection</h4>${block('claude-check', 'claude mcp get writing-scaffold', 'Copy Claude Code check command')}<p>Start a new Claude Code session and open <code>/mcp</code> to check its tools.</p></li></ol>
      ${link(claudeDocs, 'Claude Code setup reference')}` },
    { id: 'claude-gui', agent: 'Claude', mode: 'Desktop & web', intro: 'Connect from Claude Desktop or claude.ai using a custom connector.', content: `
      <ol class="steps"><li><h4>Open Connectors</h4><p>Go to <strong>Customize → Connectors</strong>. Choose <strong>+ Add → Add custom connector</strong>.</p></li>
      <li><h4>Enter the connection details</h4>${fields}<p>Continue through setup, select <strong>No sign in</strong>, then choose <strong>Add</strong>.</p></li>
      <li><h4>Enable it in your chat</h4><p>Use the chat’s <strong>+ → Connectors</strong> menu and turn on Writing Scaffold.</p></li></ol>
      <p class="aside">On a team account, an owner may need to add the connector in Organization settings first.</p>
      ${link(claudeGuiDocs, 'Claude connector reference')}` },
    { id: 'codex-cli', agent: 'Codex', mode: 'Command line', intro: 'The CLI saves this connection for Codex on your computer, including its app and IDE extension.', content: `
      <ol class="steps"><li><h4>Add the server</h4>${block('codex-add', `codex mcp add writing-scaffold --url ${endpoint}`, 'Copy Codex add command')}</li>
      <li><h4>Check the configuration</h4>${block('codex-check', 'codex mcp list', 'Copy Codex check command')}<p>Start a new Codex session. In the terminal interface, <code>/mcp</code> shows active servers.</p></li></ol>
      ${link(codexDocs, 'Codex setup reference')}` },
    { id: 'codex-gui', agent: 'Codex', mode: 'Desktop & IDE', intro: 'Add a remote MCP server in the app. The IDE extension uses the same connection settings.', content: `
      <ol class="steps"><li><h4>Open MCP settings</h4><p>In the desktop app, open <strong>Settings → MCP servers → Add server</strong>. In the IDE extension, open the gear menu, then <strong>MCP servers → Add server</strong>.</p></li>
      <li><h4>Enter the connection details</h4>${fields}<p>Select <strong>Streamable HTTP</strong> and leave authentication fields empty.</p></li>
      <li><h4>Save and restart</h4><p>Save the server, then choose <strong>Restart</strong> (or <strong>Restart extension</strong> in the IDE).</p></li></ol>
      ${link(codexDocs, 'Codex setup reference')}` },
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Connect Writing Scaffold to Pi, Claude, or Codex. Step-by-step MCP setup for the command line and graphical apps.">
<meta name="color-scheme" content="light"><title>Connect your agent · Writing Scaffold</title>
<style>
:root{--paper:#f5f4ee;--card:#fffefa;--ink:#202b23;--muted:#667065;--line:#dcded3;--green:#315641;--sage:#e6ece0;--serif:Georgia,'Times New Roman',serif;--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}button,a{-webkit-tap-highlight-color:transparent}button{font:inherit;cursor:pointer}a{color:var(--green);text-underline-offset:4px}button:focus-visible,a:focus-visible{outline:3px solid #b07839;outline-offset:4px}button:hover{filter:brightness(.96)}main,.topbar,footer{max-width:1060px;margin:auto;padding-left:32px;padding-right:32px}.topbar{height:104px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:13px;text-decoration:none;color:var(--ink);font-size:15px;font-weight:650;letter-spacing:-.25px}.brand-icon{width:31px;height:34px}.top-note{color:var(--muted);font-size:12px;letter-spacing:1.2px;text-transform:uppercase}.hero{padding:58px 0 35px;display:grid;grid-template-columns:1.1fr .9fr;align-items:end;gap:45px}.eyebrow{font:600 11px/1.4 var(--sans);letter-spacing:1.6px;text-transform:uppercase;color:var(--green);margin:0 0 19px}.eyebrow::before{content:'';display:inline-block;width:6px;height:6px;background:var(--green);border-radius:50%;margin:0 9px 1px 0}h1{font:normal clamp(40px,5.3vw,62px)/1.05 var(--serif);letter-spacing:-2.2px;margin:0}h1 em{font-weight:normal;color:var(--green)}.hero-copy{padding-bottom:3px}.hero-copy p{font-size:16px;line-height:1.8;color:var(--muted);max-width:350px;margin:0 0 17px}.small-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--green)}.small-badge svg{width:15px;height:15px}.endpoint{margin:8px 0 44px;border:1px solid var(--line);border-radius:10px;background:#eeeee5;display:flex;align-items:center;gap:18px;padding:17px 19px}.endpoint-label{white-space:nowrap;font-size:10px;font-weight:650;letter-spacing:1.35px;color:var(--muted)}.endpoint code{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;flex:1;color:var(--green)}.copy-button{flex:none;display:flex;gap:12px;align-items:center;font-size:12px;font-weight:600;padding:7px 11px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);white-space:nowrap}.section-title{display:flex;align-items:baseline;gap:12px;margin:0 0 18px}.section-title .number{font:11px ui-monospace,monospace;color:var(--muted)}h2{font:normal 25px/1.2 var(--serif);letter-spacing:-.5px;margin:0}.section-title p{margin:0 0 0 auto;color:var(--muted);font-size:12px}.agent-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:24px}.agent-card{border:1px solid var(--line);border-radius:10px;padding:19px;background:var(--card);transition:border-color .15s}.agent-card.is-selected{border-color:var(--green);box-shadow:inset 0 0 0 1px var(--green)}.agent-heading{display:flex;align-items:center;gap:10px;margin:0 0 17px}.agent-symbol{display:grid;place-items:center;font-family:var(--serif);font-size:25px;line-height:1;width:31px;height:31px;color:var(--green)}.agent-heading h3{font-size:15px;letter-spacing:-.2px;margin:0;font-weight:600}.agent-kind{margin-left:auto;color:var(--muted);font-size:10px}.mode-buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}.mode-buttons button{border:1px solid var(--line);color:var(--muted);background:transparent;border-radius:5px;font-size:12px;font-weight:600;padding:8px}.mode-buttons button[aria-pressed=true]{background:var(--green);color:white;border-color:var(--green)}.setup-panel{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}.panel-heading{padding:27px 31px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;justify-content:space-between;gap:16px}.panel-heading h2{font:600 18px/1.4 var(--sans);letter-spacing:-.35px}.panel-heading span{color:var(--muted);font-size:11px;letter-spacing:1px;text-transform:uppercase}.panel-body{padding:23px 31px 28px}.intro{color:var(--muted);margin:0 0 25px;font-size:14px;max-width:650px}.steps{list-style:none;counter-reset:step;margin:0;padding:0}.steps>li{counter-increment:step;position:relative;padding:0 0 23px 38px}.steps>li:last-child{padding-bottom:10px}.steps>li::before{content:counter(step);position:absolute;left:0;top:1px;background:var(--sage);width:23px;height:23px;border-radius:50%;font-size:11px;font-weight:600;text-align:center;line-height:23px;color:var(--green)}h4{margin:0 0 8px;font-size:14px;font-weight:600}.steps p{margin:8px 0;font-size:13px;color:var(--muted)}p code{font-size:12px;background:#edf0e8;border-radius:3px;padding:2px 4px;color:var(--green);overflow-wrap:anywhere}.code-block{display:flex;align-items:flex-start;gap:15px;background:#f0f2eb;border:1px solid #e1e5d9;border-radius:7px;padding:13px 14px;margin:8px 0}.code-block pre{flex:1;min-width:0;margin:2px 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--green)}.code-block .copy-button{padding:4px 8px;font-size:11px}.doc-link{display:inline-flex;align-items:center;gap:17px;font-size:12px;margin:12px 0 0 38px;text-decoration:none;border-bottom:1px solid var(--line)}.fields{margin:12px 0;border:1px solid var(--line);border-radius:7px;overflow:hidden;font-size:12px}.fields>div{display:grid;grid-template-columns:125px 1fr;border-bottom:1px solid var(--line)}.fields>div:last-child{border:0}.fields dt{padding:9px 13px;color:var(--muted);background:#f6f6f0}.fields dd{margin:0;padding:9px 13px;font-weight:500;overflow-wrap:anywhere}.fields .url-value{font-family:ui-monospace,monospace;font-size:11px}.aside{margin:15px 0 0 38px;font-size:12px;color:var(--muted)}.try-it{display:flex;align-items:baseline;gap:19px;margin:28px 0 36px;padding:0 2px}.try-it strong{font-size:12px;white-space:nowrap;font-weight:600}.try-it p{margin:0;color:var(--muted);font:italic 16px/1.5 var(--serif)}footer{padding-top:22px;padding-bottom:30px;border-top:1px solid var(--line);display:flex;gap:25px;justify-content:space-between;color:var(--muted);font-size:11px}footer p{margin:0}.footer-links{display:flex;gap:18px;flex-wrap:wrap}footer a{white-space:nowrap;text-decoration:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}
@media(max-width:700px){main,.topbar,footer{padding-left:22px;padding-right:22px}.topbar{height:80px}.top-note{font-size:9px;letter-spacing:.8px}.hero{grid-template-columns:1fr;gap:23px;padding-top:38px}.hero-copy p{max-width:480px;font-size:14px;margin-bottom:10px}.hero{padding-bottom:20px}h1{font-size:48px;letter-spacing:-1.6px}.endpoint{gap:10px;flex-wrap:wrap;margin-bottom:30px;padding:13px}.endpoint-label{width:100%}.endpoint code{font-size:11px}.section-title p{display:none}.agent-grid{gap:8px}.agent-card{padding:13px 10px}.agent-heading{gap:5px;flex-wrap:wrap;margin-bottom:12px}.agent-kind{display:none}.agent-symbol{font-size:21px;width:23px}.agent-heading h3{font-size:14px}.mode-buttons{gap:5px}.mode-buttons button{padding:7px 0;font-size:11px}.panel-heading{padding:20px}.panel-heading span{font-size:9px}.panel-body{padding:20px 17px}.steps>li{padding-left:31px}.code-block{padding:10px;gap:6px;flex-wrap:wrap}.code-block pre{font-size:11px;flex-basis:100%}.code-block .copy-button{margin-left:auto}.fields>div{grid-template-columns:85px 1fr}.fields dt,.fields dd{padding:8px}.doc-link,.aside{margin-left:31px}.try-it{align-items:flex-start;gap:12px}.try-it p{font-size:15px}footer{display:block}footer p{margin-bottom:9px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body>
<header class="topbar"><a class="brand" href="/mcp" aria-label="Writing Scaffold home"><svg class="brand-icon" viewBox="0 0 31 34" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5h25v25H3z"/><path d="M7 1h24v25M8 12h15M8 17h11M8 22h15"/></g></svg>Writing Scaffold</a><span class="top-note">A library for language</span></header>
<main>
<section class="hero" aria-labelledby="page-title"><div><p class="eyebrow">Connect your agent</p><h1>A writing library.<br><em>For your agent.</em></h1></div><div class="hero-copy"><p>Find a good example. Borrow its structure. Give Pi, Claude, or Codex a library to write from.</p><span class="small-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>No account or API key needed</span></div></section>
<div class="endpoint"><span class="endpoint-label">Server URL</span><code id="endpoint-url">${url}</code><button class="copy-button" type="button" data-copy="endpoint-url" aria-label="Copy server URL">Copy URL <span aria-hidden="true">⧉</span></button></div>
<section aria-labelledby="choose-title"><div class="section-title"><span class="number">01</span><h2 id="choose-title">Choose your setup</h2><p>One server. Your preferred way in.</p></div>
<div class="agent-grid" role="group" aria-label="Agent and interface">${[
  ['pi', 'Pi', 'π', 'Coding agent'], ['claude', 'Claude', '✳', 'Anthropic'], ['codex', 'Codex', '⌘', 'OpenAI'],
].map(([id, name, symbol, kind]) => `<article class="agent-card${id === 'pi' ? ' is-selected' : ''}" data-agent="${id}"><div class="agent-heading"><span class="agent-symbol" aria-hidden="true">${symbol}</span><h3>${name}</h3><span class="agent-kind">${kind}</span></div><div class="mode-buttons">${['cli', 'gui'].map(mode => `<button type="button" data-setup="${id}-${mode}" aria-controls="${id}-${mode}" aria-label="${name} ${mode.toUpperCase()}" aria-pressed="${id === 'pi' && mode === 'cli'}">${mode.toUpperCase()}</button>`).join('')}</div></article>`).join('')}</div>
${panels.map((panel, index) => `<section class="setup-panel" id="${panel.id}" aria-labelledby="${panel.id}-title"${index ? ' hidden' : ''}><div class="panel-heading"><h2 id="${panel.id}-title">${panel.agent} <span aria-hidden="true">/</span> ${panel.mode}</h2><span>Connection guide</span></div><div class="panel-body"><p class="intro">${panel.intro}</p>${panel.content}</div></section>`).join('')}
</section>
<div class="try-it"><strong>Then, try this</strong><p>“Use the writing-scaffold mcp to write a story about a man named Gregorhumdampton”</p></div>
</main>
<footer><p>Public, read-only library. Requests, including their bodies, are logged.</p><nav class="footer-links" aria-label="Related links"><a href="https://github.com/ampdot-io/ai-detection-eval" target="_blank" rel="noreferrer">View on GitHub ↗</a><a href="/pangram-miss-benchmark.html" target="_blank" rel="noreferrer">More information ↗</a></nav></footer>
<div id="copy-status" class="sr-only" role="status" aria-live="polite"></div>
<noscript><style>.setup-panel[hidden]{display:block!important}.setup-panel{margin:20px 0}.agent-grid,.copy-button{display:none!important}</style></noscript>
<script>
(function () {
  const buttons = Array.from(document.querySelectorAll('[data-setup]'));
  const panels = Array.from(document.querySelectorAll('.setup-panel'));
  const status = document.getElementById('copy-status');
  function select(id, updateUrl) {
    if (!panels.some(panel => panel.id === id)) return;
    panels.forEach(panel => { panel.hidden = panel.id !== id; });
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.setup === id)));
    document.querySelectorAll('[data-agent]').forEach(card => card.classList.toggle('is-selected', id.startsWith(card.dataset.agent + '-')));
    if (updateUrl) history.replaceState(null, '', '#' + id);
  }
  buttons.forEach(button => button.addEventListener('click', () => select(button.dataset.setup, true)));
  window.addEventListener('hashchange', () => select(location.hash.slice(1), false));
  select(location.hash.slice(1), false);
  document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const element = document.getElementById(button.dataset.copy);
      const original = button.innerHTML;
      try {
        await navigator.clipboard.writeText(element.textContent);
        button.textContent = 'Copied ✓';
        status.textContent = button.getAttribute('aria-label') + ' copied.';
        setTimeout(() => { button.innerHTML = original; }, 1800);
      } catch {
        const selection = window.getSelection();
        if (selection) { selection.removeAllRanges(); const range = document.createRange(); range.selectNodeContents(element); selection.addRange(range); }
        status.textContent = 'Text selected. Press Command+C or Control+C to copy.';
      }
    });
  });
}());
</script>
</body></html>`;
}
