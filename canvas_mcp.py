"""Stdio MCP server for a locally running CainFlow editor."""

import argparse
import asyncio
import json
import os
from http.client import HTTPConnection, HTTPException
from typing import Annotated, Any, Literal

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ImageContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field

MAX_RESPONSE_BYTES = 6_100_000
CanvasNodeType = Literal['ImageImport', 'ImageGenerate', 'ImageResize', 'ImageMerge', 'ImagePreview', 'ImageCompare', 'Text']
Offset = Annotated[int, Field(ge=0)]
NodeIds = Annotated[list[str], Field(max_length=100)]
READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)


class CanvasPlanStep(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str = Field(description='Unique reference for this step within the plan.')
    type: CanvasNodeType
    nodeId: str | None = Field(default=None, description='Existing node ID to edit in place. Omit to create a node.')
    title: str | None = None
    parameters: dict[str, str | int | float | bool] = Field(
        default_factory=dict, description='Editable node parameters from read_canvas. A new ImageGenerate requires prompt.'
    )
    assetKey: str | None = Field(default=None, description='Existing canvas media reference for an ImageImport node.')


class CanvasPort(BaseModel):
    model_config = ConfigDict(extra='forbid')

    ref: str = Field(description='A plan step ID, or an existing canvas node ID for a connection source.')
    port: str


class CanvasConnection(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source: CanvasPort = Field(alias='from')
    target: CanvasPort = Field(alias='to')
    order: int | None = None


class CanvasDeletion(BaseModel):
    model_config = ConfigDict(extra='forbid')

    nodeId: str


class CanvasPlan(BaseModel):
    model_config = ConfigDict(extra='forbid')

    version: Literal[1] = 1
    steps: list[CanvasPlanStep] = Field(default_factory=list, max_length=100)
    deletes: list[CanvasDeletion] = Field(default_factory=list, max_length=100)
    connections: list[CanvasConnection] = Field(default_factory=list, max_length=200)
    disconnects: list[CanvasPort] = Field(default_factory=list, max_length=200)


def call_canvas(port: int, token: str, method: str, args: dict[str, Any]) -> dict[str, Any]:
    # Connect directly to loopback. System proxies and redirects must not
    # receive the credential or tool arguments.
    connection = HTTPConnection('127.0.0.1', port, timeout=15)
    try:
        connection.request('POST', '/api/canvas-mcp/call', json.dumps({'method': method, 'args': args}, allow_nan=False), {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        })
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE_BYTES + 1)
        if len(data) > MAX_RESPONSE_BYTES:
            raise ToolError('The CainFlow response exceeds the maximum size.')
        status = response.status
    except (OSError, HTTPException) as error:
        raise ToolError('The CainFlow bridge could not return a response. Check the local port and read the canvas before retrying a change.') from error
    finally:
        connection.close()

    try:
        payload = json.loads(data)
    except (UnicodeError, ValueError) as error:
        raise ToolError('The local service did not return a CainFlow bridge response.') from error
    if not isinstance(payload, dict):
        raise ToolError('Invalid CainFlow bridge response.')
    if status != 200 or 'error' in payload:
        raise ToolError(str(payload.get('error') or f'CainFlow bridge returned HTTP {status}.'))
    if not isinstance(payload.get('result'), dict):
        raise ToolError('CainFlow returned no tool result.')
    return payload['result']


def create_mcp_server(port: int, token: str) -> MCPServer:
    mcp = MCPServer('CainFlow Canvas', instructions=(
        'Control the active CainFlow editor on this computer. Start with read_canvas. '
        'Use the returned editorId, workflowId and revision for edits and execution. '
        'Read again after a stale revision or a switch to another editor. Editing saves a single undoable transaction. '
        'Running is separate, can incur configured provider charges, and returns a run ID for polling.'
    ))

    async def call(method, **args):
        return await asyncio.to_thread(call_canvas, port, token, method, args)

    @mcp.tool(annotations=READ_ONLY)
    async def read_canvas(workflowId: str | None = None, nodeIds: NodeIds | None = None, offset: Offset = 0,
                          connectionOffset: Offset = 0, textOffset: Offset = 0, assetOffset: Offset = 0) -> dict[str, Any]:
        """Read the live canvas, including node IDs, editable fields, ports, connections and selection. Follow next offsets for additional pages."""
        return await call('read_canvas', **({'workflowId': workflowId} if workflowId is not None else {}),
                          nodeIds=nodeIds or [], offset=offset, connectionOffset=connectionOffset,
                          textOffset=textOffset, assetOffset=assetOffset)

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=False))
    async def edit_canvas(editorId: str, workflowId: str, revision: str, plan: CanvasPlan) -> dict[str, Any]:
        """Create, edit, delete and connect supported nodes in a single undoable transaction. Use step IDs for connection targets. Returns new revision and step-to-node bindings."""
        return await call('edit_canvas', editorId=editorId, workflowId=workflowId, revision=revision,
                          plan=plan.model_dump(by_alias=True, exclude_none=True))

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=True))
    async def run_workflow(editorId: str, workflowId: str, revision: str, nodeIds: NodeIds | None = None) -> dict[str, Any]:
        """Start the current workflow, or run only the specified nodes. Uses the configured providers. Poll get_workflow_run with the returned run ID."""
        return await call('run_workflow', editorId=editorId, workflowId=workflowId, revision=revision,
                          **({'nodeIds': nodeIds} if nodeIds is not None else {}))

    @mcp.tool(annotations=READ_ONLY)
    async def get_workflow_run(editorId: str, workflowId: str, runId: str, offset: Offset = 0) -> dict[str, Any]:
        """Read an MCP-started run's status, node outcomes and available result data. Follow nextOffset for additional nodes."""
        return await call('get_workflow_run', editorId=editorId, workflowId=workflowId, runId=runId, offset=offset)

    @mcp.tool(annotations=READ_ONLY)
    async def get_run_image(editorId: str, workflowId: str, runId: str, nodeId: str, index: Offset = 0) -> ImageContent:
        """Read a captured image from a completed MCP-started run, by zero-based image index."""
        image = await call('get_run_image', editorId=editorId, workflowId=workflowId, runId=runId, nodeId=nodeId, index=index)
        return ImageContent(type='image', mime_type=image['mimeType'], data=image['data'])

    return mcp


def main():
    parser = argparse.ArgumentParser(description='CainFlow Canvas MCP server over stdio')
    parser.add_argument('--port', type=int, default=8767, help='CainFlow editor HTTP port')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    token = os.environ.get('CAINFLOW_MCP_TOKEN', '')
    if len(token) < 32 or any(not '!' <= char <= '~' for char in token):
        parser.error('CAINFLOW_MCP_TOKEN must have at least 32 visible ASCII characters')
    create_mcp_server(args.port, token).run(transport='stdio')


if __name__ == '__main__':
    main()
