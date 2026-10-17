/** Project agent routes carry their owning project without inventing a thread. */
export function projectAgentRouteScope(
  pathname: string,
  search: string,
): { environmentId: string; projectId: string } | null {
  const conversation = /^\/([^/]+)\/agents\/[^/]+\/?$/.exec(pathname);
  if (conversation) {
    const params = new URLSearchParams(search);
    if (params.get("shared") === "true") {
      const environmentId = params.get("checkoutEnvironment");
      const projectId = params.get("checkoutProject");
      return environmentId && projectId ? { environmentId, projectId } : null;
    }
    const projectId = params.get("project");
    return projectId ? { environmentId: decodeURIComponent(conversation[1]!), projectId } : null;
  }
  const setup = /^\/([^/]+)\/projects\/([^/]+)\/(?:agents\/(?:new|propose)|start)\/?$/.exec(
    pathname,
  );
  return setup
    ? { environmentId: decodeURIComponent(setup[1]!), projectId: decodeURIComponent(setup[2]!) }
    : null;
}
