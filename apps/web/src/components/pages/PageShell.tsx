import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** Consistent header + scrollable body for every management page. */
export function PageShell({ title, subtitle, actions, children }: Props) {
  return (
    <div className="page-shell">
      <div className="page-header">
        <div className="page-title-block">
          <div className="page-title">{title}</div>
          {subtitle && <div className="page-subtitle">{subtitle}</div>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      <div className="page-body">{children}</div>
    </div>
  );
}
