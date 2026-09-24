import asyncio
import json
from collections.abc import Awaitable, Callable
from time import perf_counter

from pydantic import ValidationError

from execution_context import ExecutionContext
from order_schemas import ToolError
from tool_definition import ToolDefinition
from tool_messages import ToolCall, ToolResultMessage
from tool_result import error_message, success_message


TraceWriter = Callable[[dict], Awaitable[None]]


class TransientToolError(Exception):
    """上游临时故障，只有幂等工具才允许重试。"""


class ToolRuntime:
    def __init__(self, trace_writer: TraceWriter):
        self._tools: dict[str, ToolDefinition] = {}
        self._trace_writer = trace_writer

    def register(self, tool: ToolDefinition) -> Callable[[], None]:
        if tool.name in self._tools:
            raise ValueError(f"duplicate tool: {tool.name}")
        self._tools[tool.name] = tool

        def dispose() -> None:
            self._tools.pop(tool.name, None)

        return dispose

    def model_tools(self, ctx: ExecutionContext) -> list[dict]:
        return [
            tool.to_model_tool()
            for tool in self._tools.values()
            if tool.permission in ctx.permissions
        ]

    async def execute(
        self,
        call: ToolCall,
        ctx: ExecutionContext,
    ) -> ToolResultMessage:
        started = perf_counter()
        tool = self._tools.get(call.name)

        if tool is None:
            return await self._finish_error(
                call,
                ctx,
                started,
                ToolError(
                    code="TOOL_NOT_FOUND",
                    message="工具不存在或当前不可用",
                ),
            )

        try:
            args = tool.input_model.model_validate_json(
                call.arguments_json
            )
        except ValidationError as exc:
            issues = [
                {
                    "path": ".".join(str(part) for part in item["loc"]),
                    "message": item["msg"],
                }
                for item in exc.errors(
                    include_url=False,
                    include_input=False,
                )
            ]
            return await self._finish_error(
                call,
                ctx,
                started,
                ToolError(
                    code="INVALID_ARGUMENT",
                    message=json.dumps(issues, ensure_ascii=False),
                ),
            )

        if tool.permission not in ctx.permissions:
            return await self._finish_error(
                call,
                ctx,
                started,
                ToolError(
                    code="PERMISSION_DENIED",
                    message="当前身份没有调用该工具的权限",
                ),
            )

        if tool.risk == "high" and call.id not in ctx.approved_call_ids:
            return await self._finish_error(
                call,
                ctx,
                started,
                ToolError(
                    code="APPROVAL_REQUIRED",
                    message="该调用需要用户确认",
                ),
            )

        for attempt in range(1, tool.max_retries + 2):
            try:
                raw_output = await asyncio.wait_for(
                    tool.handler(args, ctx),
                    timeout=tool.timeout_seconds,
                )

                output = tool.output_model.model_validate(raw_output)
                await self._write_trace(
                    call=call,
                    ctx=ctx,
                    started=started,
                    status="success",
                    attempt=attempt,
                )
                return success_message(call, output)

            except (asyncio.TimeoutError, TimeoutError):
                error = ToolError(
                    code="TIMEOUT",
                    message="工具执行超时",
                    retryable=tool.idempotent,
                )
            except TransientToolError:
                error = ToolError(
                    code="UPSTREAM_ERROR",
                    message="上游服务暂时不可用",
                    retryable=tool.idempotent,
                )
            except ValidationError:
                error = ToolError(
                    code="INVALID_OUTPUT",
                    message="工具返回结果不符合 Output Schema",
                )
            except Exception:
                error = ToolError(
                    code="UPSTREAM_ERROR",
                    message="工具执行失败",
                )

            can_retry = (
                error.retryable
                and tool.idempotent
                and attempt <= tool.max_retries
            )
            if not can_retry:
                return await self._finish_error(
                    call,
                    ctx,
                    started,
                    error,
                    attempt=attempt,
                )

            await asyncio.sleep(min(0.25 * 2 ** (attempt - 1), 2.0))

        raise AssertionError("unreachable")

    async def _finish_error(
        self,
        call: ToolCall,
        ctx: ExecutionContext,
        started: float,
        error: ToolError,
        attempt: int = 0,
    ) -> ToolResultMessage:
        await self._write_trace(
            call=call,
            ctx=ctx,
            started=started,
            status="error",
            attempt=attempt,
            error_code=error.code,
        )
        return error_message(call, error)

    async def _write_trace(
        self,
        *,
        call: ToolCall,
        ctx: ExecutionContext,
        started: float,
        status: str,
        attempt: int,
        error_code: str | None = None,
    ) -> None:
        await self._trace_writer({
            "trace_id": ctx.trace_id,
            "tool_call_id": call.id,
            "tool_name": call.name,
            "user_id": ctx.user_id,
            "tenant_id": ctx.tenant_id,
            "status": status,
            "attempt": attempt,
            "latency_ms": int((perf_counter() - started) * 1000),
            "error_code": error_code,
        })
