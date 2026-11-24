"use client";

import {
  Children,
  createContext,
  isValidElement,
  useActionState,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";

import { ActionNotice } from "@/app/components/action-notice";
import {
  INITIAL_KEPT_FORM_STATE,
  keptInputDefault,
  keptSelectDefault,
  type KeptFormState,
} from "@/app/lib/kept-form-core";

/**
 * FE-L3: a form whose Server Action is called through useActionState, so a
 * REFUSED submission keeps what the user typed (app/lib/kept-form-core.ts).
 *
 * - Refusal: the action returns the fixed notice message and the allowlisted,
 *   non-secret values; the notice is shown above the form and the form is
 *   re-mounted, its <KeptInput>/<KeptSelect> fields rendering the kept values
 *   as defaultValue (at render time, so a no-JavaScript POST gets them too).
 *   Password fields are plain inputs and stay empty.
 * - Success: the action returns no values; the re-mounted form shows its
 *   defaults, as the automatic reset did before.
 * - Redirects (a role refusal, the B05 success notice) are Next.js router
 *   navigations and are not handled here.
 */
const KeptValuesContext = createContext<Readonly<Record<string, string>>>({});

export function KeepInputForm({
  action,
  className,
  noticeClassName,
  children,
}: {
  action: (state: KeptFormState, formData: FormData) => Promise<KeptFormState>;
  className?: string;
  noticeClassName?: string;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, INITIAL_KEPT_FORM_STATE);

  return (
    <>
      {state.notice ? (
        <div className={noticeClassName}>
          <ActionNotice message={state.notice} />
        </div>
      ) : null}
      <KeptValuesContext value={state.values}>
        <form key={state.submission} action={formAction} className={className}>
          {children}
        </form>
      </KeptValuesContext>
    </>
  );
}

/** An <input> that shows its kept value after a refusal (never for password/hidden/file). */
export function KeptInput(props: ComponentProps<"input"> & { name: string }) {
  const values = useContext(KeptValuesContext);
  return <input {...props} defaultValue={keptInputDefault(values, props.name, props.type, props.defaultValue)} />;
}

/** A <select> that shows its kept value after a refusal, if that option still exists. */
export function KeptSelect(props: ComponentProps<"select"> & { name: string }) {
  const values = useContext(KeptValuesContext);
  const options: string[] = [];
  Children.forEach(props.children, (child) => {
    if (isValidElement<{ value?: unknown }>(child) && child.type === "option") {
      options.push(String(child.props.value ?? ""));
    }
  });
  return <select {...props} defaultValue={keptSelectDefault(values, props.name, options, props.defaultValue)} />;
}
