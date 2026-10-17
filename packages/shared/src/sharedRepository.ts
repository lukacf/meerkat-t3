/**
 * Shared membership needs stronger identity than display grouping: preserve
 * non-default ports and case-sensitive forge paths, and reject local folders.
 * Aliases are explicit; a fork's name never implies the parent's identity.
 */
export function canonicalSharedRepository(remote: string): string {
  const value = remote.trim();
  if (
    !value ||
    /^[/.~]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    // eslint-disable-next-line no-control-regex -- Control bytes cannot identify a remote repository.
    /[\s\\\u0000-\u001f]/.test(value)
  )
    throw new Error("Use a repository remote URL, not a local folder.");
  let host: string;
  let port = "";
  let path: string;
  const scp = /^[a-zA-Z0-9._-]+@([^:/]+):(.+)$/.exec(value);
  if (scp) {
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  } else {
    // Accept a previously canonicalized host/path as well as a remote URL.
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      !["https:", "http:", "ssh:", "git:"].includes(url.protocol) ||
      !url.hostname ||
      url.password ||
      url.search ||
      url.hash ||
      ((url.protocol === "http:" || url.protocol === "https:") && url.username)
    )
      throw new Error("Use a repository URL without credentials, query parameters or fragments.");
    host = url.hostname.toLowerCase();
    port = url.port;
    if ((url.protocol === "ssh:" && port === "22") || (url.protocol === "git:" && port === "9418"))
      port = "";
    path = url.pathname;
  }
  // Encoded separators and dot segments must not create a second interpretation.
  if (
    !/^[a-z0-9.-]+$/.test(host) ||
    /(?:^|\/)\.{1,2}(?:\/|$)|%|[?#]/.test(path) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(value.replace(/^[a-z]+:\/\//i, ""))
  )
    throw new Error("The repository URL has an ambiguous host or path.");
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (path.split("/").length < 2 || path.split("/").some((segment) => !segment))
    throw new Error("A repository identity needs a host, owner and repository.");
  if (host === "github.com" || host === "gitlab.com" || host === "bitbucket.org")
    path = path.toLowerCase();
  const result = `${host}${port ? `:${port}` : ""}/${path}`;
  if (result.length > 2048) throw new Error("The repository identity is too long.");
  return result;
}
