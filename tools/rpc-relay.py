# Local JSON-RPC relay to Robinhood Chain's official RPC, by its IP (this network's DNS blocks the name), with the
# right TLS server name, so Anvil can fork from it: FORK_URL=http://127.0.0.1:8611
import http.server, socket, ssl, sys
HOST, IP, PORT = "rpc.mainnet.chain.robinhood.com", "104.20.46.209", int(sys.argv[1] if len(sys.argv) > 1 else 8611)
ctx = ssl.create_default_context()

def forward(body):
    with socket.create_connection((IP, 443), timeout=60) as raw, ctx.wrap_socket(raw, server_hostname=HOST) as s:
        s.sendall(b"POST / HTTP/1.1\r\nHost: " + HOST.encode() + b"\r\nContent-Type: application/json\r\nUser-Agent: curl/8.4.0\r\n"
                  b"Connection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        data = b""
        while chunk := s.recv(65536):
            data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    if b"transfer-encoding: chunked" in head.lower():
        out = b""
        while rest:
            size, _, rest = rest.partition(b"\r\n")
            n = int(size.split(b";")[0], 16)
            if n == 0:
                break
            out, rest = out + rest[:n], rest[n + 2:]
        rest = out
    return status, rest

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        try:
            status, out = forward(body)
        except Exception as e:
            status, out = 502, str(e).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
