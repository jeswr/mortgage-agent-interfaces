#!/usr/bin/env node
// Logging pass-through proxy for the Anthropic API.
// Every request the agent runtime makes (including any not shown in its
// stream-json output) is forwarded unchanged to the upstream API and logged
// to a JSONL file with model, message id and usage parsed from the response.
// Usage: node llm-proxy.js <port> <logfile> [upstream]
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const port = Number(process.argv[2] || 8899);
const logFile = process.argv[3] || 'llm-proxy.jsonl';
const upstream = new URL(process.argv[4] || 'https://api.anthropic.com');

function log(obj) { fs.appendFileSync(logFile, JSON.stringify(obj) + '\n'); }

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const t0 = Date.now();
    let reqModel = null; let stream = null; let nTools = null; let nMsgs = null;
    if (body.length && /json/.test(req.headers['content-type'] || '')) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        reqModel = j.model || null; stream = !!j.stream;
        nTools = Array.isArray(j.tools) ? j.tools.length : null;
        nMsgs = Array.isArray(j.messages) ? j.messages.length : null;
      } catch (e) { /* ignore */ }
    }
    const headers = { ...req.headers, host: upstream.host };
    delete headers['accept-encoding']; // keep responses parseable
    const up = https.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || 443,
      method: req.method, path: req.url, headers,
    }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      const rc = [];
      ur.on('data', (c) => { rc.push(c); res.write(c); });
      ur.on('end', () => {
        res.end();
        const text = Buffer.concat(rc).toString('utf8');
        const entry = { ts: new Date(t0).toISOString(), ms: Date.now() - t0, method: req.method,
          path: req.url, status: ur.statusCode, req_model: reqModel, stream, n_tools: nTools,
          n_messages: nMsgs, req_bytes: body.length, resp_bytes: text.length };
        try {
          if (/text\/event-stream/.test(ur.headers['content-type'] || '')) {
            let usage = {}; let id = null; let model = null; let stop = null;
            for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue;
              let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
              if (ev.type === 'message_start') { id = ev.message.id; model = ev.message.model; usage = { ...ev.message.usage }; }
              if (ev.type === 'message_delta') { usage = { ...usage, ...ev.usage }; stop = ev.delta && ev.delta.stop_reason; }
            }
            Object.assign(entry, { id, model, usage, stop_reason: stop });
          } else if (/json/.test(ur.headers['content-type'] || '')) {
            const j = JSON.parse(text);
            if (j && j.usage) Object.assign(entry, { id: j.id, model: j.model, usage: j.usage, stop_reason: j.stop_reason });
          }
        } catch (e) { entry.parse_error = String(e); }
        log(entry);
      });
    });
    up.on('error', (e) => { log({ ts: new Date(t0).toISOString(), path: req.url, error: String(e) }); res.writeHead(502); res.end(); });
    up.end(body);
  });
}).listen(port, '127.0.0.1', () => { process.stdout.write(`llm-proxy on ${port}\n`); });
