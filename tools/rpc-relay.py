# Local JSON-RPC relay to Robinhood Chain's official RPC, by its IP (this network's DNS blocks the name), with the
# right TLS server name, so Anvil and forge can use it: FORK_URL=http://127.0.0.1:8611 or RPC_URL=http://127.0.0.1:8611.
#
# Each relay thread keeps one connection to the RPC open and reuses it: a deploy's simulation sends hundreds of
# requests, and opening a fresh TLS connection for each makes the RPC's edge reset some of them. A request that fails
# on the network is tried again on a fresh connection (up to three times) before the relay answers 502.
import http.client, http.server, socket, ssl, sys, threading, time

HOST, IP, PORT = "rpc.mainnet.chain.robinhood.com", "104.20.46.209", int(sys.argv[1] if len(sys.argv) > 1 else 8611)
ctx = ssl.create_default_context()
local = threading.local()


class Upstream(http.client.HTTPSConnection):
    """An HTTPS connection to the RPC's IP that still says its name (SNI and Host)."""

    def connect(self):
        raw = socket.create_connection((IP, 443), timeout=self.timeout)
        self.sock = ctx.wrap_socket(raw, server_hostname=HOST)


def forward(body):
    for attempt in range(3):
        conn = getattr(local, "conn", None) or Upstream(HOST, 443, timeout=30)
        local.conn = conn
        try:
            conn.request("POST", "/", body, {"Content-Type": "application/json", "User-Agent": "curl/8.4.0"})
            res = conn.getresponse()
            return res.status, res.read()
        except (OSError, http.client.HTTPException):
            conn.close()
            local.conn = None
            time.sleep(0.3 * (attempt + 1))
    raise OSError("the RPC didn't answer after three tries")


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
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
