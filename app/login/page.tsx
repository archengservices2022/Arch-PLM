import { redirect, unstable_rethrow } from "next/navigation";

import { signIn } from "@/auth";
import { getActor } from "@/app/lib/authz";
import {
  isSignInErrorParam,
  runSignInAttempt,
  SIGN_IN_FAILED_MESSAGE,
  SIGN_IN_REFUSED_HREF,
} from "@/app/lib/action-notice-core";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  // B05: only a session that getActor() accepts (active user, current
  // password version) counts as signed in. Checking the bare cookie here
  // would bounce a refused session between "/" and "/login" forever.
  if (await getActor()) {
    redirect("/");
  }

  // KI-1: only the exact value set by the login action shows the (fixed,
  // generic) message; any other value is ignored.
  const signInFailed = isSignInErrorParam((await searchParams).error);

  async function login(formData: FormData) {
    "use server";

    const email = formData.get("email");
    const password = formData.get("password");

    if (typeof email !== "string" || typeof password !== "string") {
      return;
    }

    // KI-1: refused credentials (unknown email, wrong password, inactive
    // account - Auth.js reports all three the same way) come back to this
    // page with one generic message. A successful sign-in's redirect and any
    // other error are rethrown unchanged. The redirect below is outside the
    // try/catch inside runSignInAttempt, as Next.js requires.
    const outcome = await runSignInAttempt(
      () =>
        signIn("credentials", {
          email,
          password,
          redirectTo: "/",
        }),
      { rethrowFramework: unstable_rethrow },
    );

    if (outcome === "refused") {
      redirect(SIGN_IN_REFUSED_HREF);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f7fa",
        padding: "24px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "420px",
          background: "#ffffff",
          borderRadius: "16px",
          padding: "40px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.08)",
        }}
      >
        <div style={{ marginBottom: "32px" }}>
          <h1
            style={{
              margin: 0,
              fontSize: "30px",
              fontWeight: 700,
            }}
          >
            Arch PLM
          </h1>

          <p
            style={{
              marginTop: "8px",
              color: "#667085",
            }}
          >
            Product Lifecycle Management
          </p>
        </div>

        {signInFailed ? (
          <p
            role="alert"
            data-testid="sign-in-error"
            style={{
              marginTop: 0,
              marginBottom: "20px",
              padding: "12px 14px",
              borderRadius: "8px",
              border: "1px solid #fda29b",
              background: "#fef3f2",
              color: "#912018",
              fontSize: "14px",
            }}
          >
            {SIGN_IN_FAILED_MESSAGE}
          </p>
        ) : null}

        <form action={login}>
          <div style={{ marginBottom: "20px" }}>
            <label
              htmlFor="email"
              style={{
                display: "block",
                marginBottom: "8px",
                fontWeight: 600,
              }}
            >
              Email
            </label>

            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "12px 14px",
                border: "1px solid #d0d5dd",
                borderRadius: "8px",
                fontSize: "16px",
              }}
            />
          </div>

          <div style={{ marginBottom: "24px" }}>
            <label
              htmlFor="password"
              style={{
                display: "block",
                marginBottom: "8px",
                fontWeight: 600,
              }}
            >
              Password
            </label>

            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="Enter your password"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "12px 14px",
                border: "1px solid #d0d5dd",
                borderRadius: "8px",
                fontSize: "16px",
              }}
            />
          </div>

          <button
            type="submit"
            style={{
              width: "100%",
              padding: "13px 16px",
              border: 0,
              borderRadius: "8px",
              background: "#111827",
              color: "#ffffff",
              fontSize: "16px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Sign in to Arch PLM
          </button>
        </form>

        <p
          style={{
            marginTop: "24px",
            marginBottom: 0,
            textAlign: "center",
            color: "#98a2b3",
            fontSize: "13px",
          }}
        >
          Secure engineering data management
        </p>
      </div>
    </main>
  );
}