import { useEffect, useState, type ReactNode, type MouseEvent } from "react";

/** Current hash route, e.g. "/", "/diagnostics". Scrolls to top on change. */
export const useHashRoute = (): string => {
  const [route, setRoute] = useState<string>(() => window.location.hash.replace(/^#/, "") || "/");
  useEffect(() => {
    const onHash = (): void => {
      setRoute(window.location.hash.replace(/^#/, "") || "/");
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
};

export const navigate = (to: string): void => {
  window.location.hash = to;
};

export function Link({
  to,
  className,
  children,
  onClick,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  const external = to.startsWith("http");
  const handle = (e: MouseEvent): void => {
    if (external) return;
    e.preventDefault();
    navigate(to);
    onClick?.();
  };
  return (
    <a href={external ? to : `#${to}`} className={className} onClick={handle}>
      {children}
    </a>
  );
}
