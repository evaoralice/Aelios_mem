// 角色记忆 role_scope 生成工具
// role_scope 由服务端统一生成，客户端不可传入。
// 规则:
//   有 role_id    → id:<role_id>
//   无 ID 有名称  → name:<trim + NFKC 规范化名称>
//   都没有        → shared

export function computeRoleScope(
  roleId?: string | null,
  roleName?: string | null
): string {
  if (roleId) return `id:${roleId}`;
  if (roleName) {
    const normalized = roleName.trim().normalize("NFKC");
    if (normalized) return `name:${normalized}`;
  }
  return "shared";
}

export function isSharedScope(roleScope: string): boolean {
  return roleScope === "shared";
}