"""Unit tests for OrgToolRegistry filter wrapper."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from harness.mcp.registry_bridge import OrgToolRegistry
from harness.tools.protocol import CostClass, ToolContext, ToolResult
from harness.tools.registry import ToolRegistry


class _FakeTool:
    def __init__(self, name: str, org_id: int | None = None) -> None:
        self.name = name
        self.description = f"Tool {name}"
        self.cost_class = CostClass.CHEAP
        self.input_schema = type("Schema", (BaseModel,), {})
        if org_id is not None:
            self._org_id = org_id

    async def run(self, ctx: ToolContext, input: BaseModel) -> ToolResult:
        from harness.tools.protocol import ToolError
        return ToolResult(data="ok", truncated=False)


class TestOrgToolRegistry:
    def _registry_with(self, *tools: _FakeTool) -> ToolRegistry:
        r = ToolRegistry()
        for t in tools:
            r.register(t)
        return r

    def test_native_tools_visible_to_all_orgs(self) -> None:
        native = _FakeTool("list_dashboards")  # no _org_id
        r = self._registry_with(native)
        org1 = OrgToolRegistry(org_id=1, registry=r)
        org2 = OrgToolRegistry(org_id=2, registry=r)
        assert native in org1.all_tools()
        assert native in org2.all_tools()

    def test_mcp_tool_visible_only_to_owner_org(self) -> None:
        mcp_tool = _FakeTool("mcp:github:list_repos", org_id=1)
        r = self._registry_with(mcp_tool)
        org1 = OrgToolRegistry(org_id=1, registry=r)
        org2 = OrgToolRegistry(org_id=2, registry=r)
        assert mcp_tool in org1.all_tools()
        assert mcp_tool not in org2.all_tools()

    def test_get_raises_key_error_for_other_org_tool(self) -> None:
        mcp_tool = _FakeTool("mcp:k8s:list_pods", org_id=5)
        r = self._registry_with(mcp_tool)
        org = OrgToolRegistry(org_id=99, registry=r)
        with pytest.raises(KeyError):
            org.get("mcp:k8s:list_pods")

    def test_tool_specs_excludes_other_org_tools(self) -> None:
        native = _FakeTool("native_tool")
        mcp_org1 = _FakeTool("mcp:svc:tool_a", org_id=1)
        mcp_org2 = _FakeTool("mcp:svc:tool_b", org_id=2)
        r = self._registry_with(native, mcp_org1, mcp_org2)
        specs = OrgToolRegistry(org_id=1, registry=r).tool_specs()
        names = [s["name"] for s in specs]
        assert "native_tool" in names
        assert "mcp:svc:tool_a" in names
        assert "mcp:svc:tool_b" not in names

    def test_tools_by_cost_class_scoped(self) -> None:
        cheap_native = _FakeTool("native_cheap")
        cheap_native.cost_class = CostClass.CHEAP
        query_mcp = _FakeTool("mcp:x:q", org_id=3)
        query_mcp.cost_class = CostClass.QUERY
        r = self._registry_with(cheap_native, query_mcp)
        org3_cheap = OrgToolRegistry(org_id=3, registry=r).tools_by_cost_class(CostClass.CHEAP)
        org3_query = OrgToolRegistry(org_id=3, registry=r).tools_by_cost_class(CostClass.QUERY)
        assert cheap_native in org3_cheap
        assert query_mcp in org3_query

    def test_empty_registry(self) -> None:
        r = ToolRegistry()
        org = OrgToolRegistry(org_id=1, registry=r)
        assert org.all_tools() == []
        assert org.tool_specs() == []
