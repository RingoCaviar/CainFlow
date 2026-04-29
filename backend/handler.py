import http.server

from backend import state
from backend.routes import settings_routes, workflow_routes
from backend.services.http_helpers import write_error, write_text
from backend.services.log_service import should_log_path, start_request_log
from backend.services.proxy_service import handle_proxy_request


class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.wasm': 'application/wasm',
    }

    def log_message(self, format, *args):
        path = str(args[0]) if len(args) > 0 else ''
        if state.is_noise_request(path):
            return
        super().log_message(format, *args)

    def do_GET(self):
        self._begin_request_log()
        try:
            if workflow_routes.handle_get(self):
                return
            if settings_routes.handle_get(self):
                return
            if state.is_noise_request(self.path):
                self.send_response(404)
                self.end_headers()
                return
            if should_log_path(self.path):
                write_error(self, 404, 'Not Found')
                return
            super().do_GET()
        except Exception as error:
            self._handle_unexpected_error(error)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        static_path = self.path.split('?', 1)[0].lower()
        if static_path.endswith(('.html', '.css', '.js', '.mjs')):
            self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def do_OPTIONS(self):
        self._begin_request_log()
        if should_log_path(self.path):
            write_text(self, '', status=200)
            return
        self.send_response(200, 'ok')
        self.end_headers()

    def do_POST(self):
        self._begin_request_log()
        try:
            if settings_routes.handle_post(self):
                return
            if self.path == '/proxy':
                handle_proxy_request(self)
                return
            if workflow_routes.handle_post(self):
                return
            if should_log_path(self.path):
                write_error(self, 404, 'Not Found')
                return
            self.send_error(404, 'Not Found')
        except Exception as error:
            self._handle_unexpected_error(error)

    def do_DELETE(self):
        self._begin_request_log()
        try:
            if settings_routes.handle_delete(self):
                return
            if workflow_routes.handle_delete(self):
                return
            if should_log_path(self.path):
                write_error(self, 404, 'Not Found')
                return
            self.send_error(404, 'Not Found')
        except Exception as error:
            self._handle_unexpected_error(error)

    def _begin_request_log(self):
        start_request_log(self)

    def _handle_unexpected_error(self, error):
        if should_log_path(self.path):
            write_error(self, 500, 'Internal Server Error', error)
            return
        raise error


"""HTTP request handler for static assets and backend API routes."""
