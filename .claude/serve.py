import os, http.server, socketserver

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    def log_message(self, fmt, *args):
        pass

port = int(os.environ.get('PORT', '8124'))
socketserver.TCPServer.allow_reuse_address = True
print('serving on', port, flush=True)
socketserver.TCPServer(('127.0.0.1', port), H).serve_forever()
