import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

// Utility pages return to the last workspace location. Help has its own Back
// button; Settings, Usage, and Pull Requests use the sidebar's. Legacy
// `/projects/<key>` links redirect into settings and are never remembered.
export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/help" ||
    pathname === "/pull-requests"
  );
}

const MAIN_APP_HREF_STORAGE_KEY = "t3code:last-main-app-href:v1";
let mainAppHref: string | null = null;

function validMainAppHref(href: string | null): string | null {
  if (!href?.startsWith("/") || href.startsWith("//") || /[\s\p{Cc}\\]/u.test(href)) return null;
  try {
    // Validate escapes in the query and hash too, without changing the saved URL.
    decodeURI(href);
    const pathname = decodeURIComponent(new URL(href, "https://t3.invalid").pathname);
    const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
    if (
      pathname.startsWith("//") ||
      /[\p{Cc}\\]/u.test(pathname) ||
      normalizedPathname === "/projects" ||
      isSidebarUtilityPage(normalizedPathname)
    )
      return null;
    return href;
  } catch {
    return null;
  }
}

function readMainAppHref(): string | null {
  if (mainAppHref !== null) return mainAppHref;
  try {
    return validMainAppHref(window.sessionStorage.getItem(MAIN_APP_HREF_STORAGE_KEY));
  } catch {
    // Direct utility-page entry still works without browser storage or a window.
    return null;
  }
}

// Mount once in the app shell. Records the latest main app URL so Back can
// return there no matter how many utility pages were visited since. Session
// storage retains this tab's destination across reloads without sharing it
// with other open tabs.
export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    const validHref = validMainAppHref(href);
    if (validHref === null) return;
    mainAppHref = validHref;
    try {
      window.sessionStorage.setItem(MAIN_APP_HREF_STORAGE_KEY, validHref);
    } catch {
      // Keep live Back navigation available even when storage is blocked.
    }
  }, [href]);
  return null;
}

// Leaves a utility page for the last main app URL, or the app landing page
// when no valid destination is available.
export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ href: readMainAppHref() ?? "/" }), [navigate]);
}
