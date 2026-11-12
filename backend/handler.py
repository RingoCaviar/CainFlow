import http.server

from backend import state
from backend import desktop_security
from backend.routes import canvas_mcp_routes, conversation_routes, diagnostic_routes, media_routes, notification_routes, protocol_routes, settings_routes, storage_routes, update_routes, workflow_routes
from backend.services.http_helpers import write_error, write_text
from backend.services.log_service import should_log_path, start_request_log
from backend.services.proxy_service import handle_proxy_request


class ProxyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    # Static modules and styles already carry Content-Length. Let the browser
    # reuse their connections instead of opening one TCP socket per asset.
    # API helpers and streaming routes explicitly retain Connection: close.
    protocol_version = 'HTTP/1.1'

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.wasm': 'application/wasm',
    }

    def log_message(self, format, *args):
        # Keep the terminal focused on startup/errors; request details are
        # already written to structured backend log files when needed.
        return

    def do_GET(self):
        if canvas_mcp_routes.handle(self):
            return
        self._begin_request_log()
        try:
            if desktop_security.handle_bootstrap(self):
                return
            if not self._authorize_desktop_api():
                return
            if update_routes.handle_get(self):
                return
            if workflow_routes.handle_get(self):
                return
            if media_routes.handle_get(self):
                return
            if protocol_routes.handle_get(self):
                return
            if settings_routes.handle_get(self):
                return
            if storage_routes.handle_get(self):
                return
            if conversation_routes.handle_get(self):
                return
            if diagnostic_routes.handle_get(self):
                return
            if state.is_noise_request(self.path):
                self.send_response(404)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if should_log_path(self.path):
                write_error(self, 404, 'Not Found')
                return
            super().do_GET()
        except Exception as error:
            self._handle_unexpected_error(error)

    def end_headers(self):
        path = getattr(self, 'path', '')
        if not canvas_mcp_routes.is_canvas_mcp_path(path):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', '*')
            static_path = path.split('?', 1)[0].lower()
            if static_path.endswith(('.html',)):
                self.send_header('Cache-Control', 'no-cache')
            elif static_path.endswith(('.css', '.js', '.mjs')):
                self.send_header('Cache-Control', 'public, max-age=0, must-revalidate')
        super().end_headers()

    def do_HEAD(self):
        if not canvas_mcp_routes.handle(self):
            super().do_HEAD()

    def send_head(self):
        # The source tree can also be the static root. Keep the MCP credential
        # and its atomic-write files outside the static handler's reach.
        settings = getattr(self.server, 'canvas_mcp_settings', None)
        if settings is not None:
            try:
                if settings.is_private_static_path(self.translate_path(self.path)):
                    self.send_error(404, 'File not found')
                    return None
            except (OSError, RuntimeError, ValueError):
                self.send_error(404, 'File not found')
                return None
        return super().send_head()

    def do_OPTIONS(self):
        if canvas_mcp_routes.handle(self):
            return
        self._begin_request_log()
        if not self._authorize_desktop_api():
            return
        if should_log_path(self.path):
            write_text(self, '', status=200)
            return
        self.send_response(200, 'ok')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        if canvas_mcp_routes.handle(self):
            return
        self._begin_request_log()
        try:
            if not self._authorize_desktop_api():
                return
            if notification_routes.handle_post(self):
                return
            if settings_routes.handle_post(self):
                return
            if update_routes.handle_post(self):
                return
            if media_routes.handle_post(self):
                return
            if protocol_routes.handle_post(self):
                return
            if storage_routes.handle_post(self):
                return
            if conversation_routes.handle_post(self):
                return
            if diagnostic_routes.handle_post(self):
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
        if canvas_mcp_routes.handle(self):
            return
        self._begin_request_log()
        try:
            if not self._authorize_desktop_api():
                return
            if settings_routes.handle_delete(self):
                return
            if workflow_routes.handle_delete(self):
                return
            if protocol_routes.handle_delete(self):
                return
            if storage_routes.handle_delete(self):
                return
            if conversation_routes.handle_delete(self):
                return
            if should_log_path(self.path):
                write_error(self, 404, 'Not Found')
                return
            self.send_error(404, 'Not Found')
        except Exception as error:
            self._handle_unexpected_error(error)

    def do_PUT(self):
        if canvas_mcp_routes.handle(self):
            return
        self._begin_request_log()
        try:
            if not self._authorize_desktop_api():
                return
            if storage_routes.handle_put(self):
                return
            if conversation_routes.handle_put(self):
                return
            if should_log_path(self.path):
                write_error(self, 404, 'Not Found')
                return
            self.send_error(404, 'Not Found')
        except Exception as error:
            self._handle_unexpected_error(error)

    def _begin_request_log(self):
        start_request_log(self)

    def _authorize_desktop_api(self):
        if desktop_security.is_api_request_authorized(self):
            return True
        write_error(self, 403, 'Desktop session is required')
        return False

    def _handle_unexpected_error(self, error):
        if should_log_path(self.path):
            write_error(self, 500, 'Internal Server Error', error)
            return
        raise error


"""HTTP request handler for static assets and backend API routes."""
