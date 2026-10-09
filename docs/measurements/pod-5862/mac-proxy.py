#!/usr/bin/env python3
"""Frozen public frontend with live API/WS proxy. Run only on the leased Mac.

No credentials or response bodies are logged or cached. Bind loopback only.
"""
import argparse
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import ssl
import threading
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--web', required=True, type=Path)
parser.add_argument('--upstream', required=True)
parser.add_argument('--port', type=int, default=19588)
args = parser.parse_args()
upstream = urlsplit(args.upstream)
assert upstream.scheme == 'https' and upstream.hostname == 'ludovico.shetland-banjo.ts.net'
stamp = json.loads((args.web / 'podium-build.json').read_text())
tls = ssl.create_default_context()
# The runner's default OpenSSL handshake times out on this route; this verified
# certificate/ECDHE context reaches the same endpoint as macOS curl.
tls.set_ecdh_curve('prime256v1')
routes = ('/health', '/version', '/trpc', '/sync', '/files', '/setup', '/auth', '/client', '/daemon', '/mobile')
hop = {'connection', 'transfer-encoding', 'keep-alive', 'host', 'upgrade'}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(args.web), **kw)

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.proxy()

    def do_GET(self):
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            self.websocket()
        elif self.path.startswith(routes):
            self.proxy()
        else:
            if not (args.web / urlsplit(self.path).path.lstrip('/')).is_file():
                self.path = '/index.html'
            super().do_GET()

    def proxy(self):
        conn = http.client.HTTPSConnection(upstream.hostname, upstream.port, timeout=30, context=tls)
        try:
            headers = {k:v for k,v in self.headers.items() if k.lower() not in hop}
            headers['Host'] = upstream.netloc
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            conn.request(self.command, self.path, body=body or None, headers=headers)
            response = conn.getresponse()
            if urlsplit(self.path).path == '/version' and response.status == 200:
                value = json.loads(response.read())
                value['web'] = {**value.get('web', {}), 'present':True, 'appVersion':stamp['appVersion'], 'digest':stamp['sourceSha'], 'bundle':stamp['bundleVersion']}
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(response.status)
            for k,v in response.getheaders():
                if k.lower() not in hop:
                    self.send_header(k,v)
            self.send_header('Connection', 'close')
            self.end_headers()
            while chunk := response.read(65536):
                self.wfile.write(chunk)
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            conn.close()

    def websocket(self):
        remote = tls.wrap_socket(socket.create_connection((upstream.hostname, upstream.port), timeout=30), server_hostname=upstream.hostname)
        try:
            lines = [f'{self.command} {self.path} HTTP/1.1', f'Host: {upstream.netloc}']
            lines += [f'{k}: {v}' for k,v in self.headers.items() if k.lower() != 'host']
            remote.sendall(('\r\n'.join(lines)+'\r\n\r\n').encode())
            header = bytearray()
            while not header.endswith(b'\r\n\r\n') and len(header) < 32768:
                chunk = remote.recv(1)
                if not chunk: return
                header.extend(chunk)
            self.connection.sendall(header)
            remote.settimeout(None)
            self.connection.settimeout(None)
            def pump(source, destination):
                try:
                    while chunk := source.recv(65536):
                        destination.sendall(chunk)
                except OSError:
                    pass
                finally:
                    try: destination.shutdown(socket.SHUT_WR)
                    except OSError: pass
            outgoing = threading.Thread(target=pump, args=(self.connection, remote), daemon=True)
            outgoing.start()
            pump(remote, self.connection)
            outgoing.join(timeout=2)
        finally:
            self.close_connection = True
            remote.close()

server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
server.daemon_threads = True
server.serve_forever()
