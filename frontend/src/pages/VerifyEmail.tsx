import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { authApi } from "../api";

type VerificationState = "loading" | "success" | "error";

const VerifyEmail = () => {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [state, setState] = useState<VerificationState>("loading");
  const [message, setMessage] = useState("Verifying your email address...");

  useEffect(() => {
    let isMounted = true;

    const verifyEmail = async () => {
      if (!token) {
        setState("error");
        setMessage("Verification token is missing.");
        return;
      }

      try {
        const response = await authApi.verifyEmail({ token });
        if (!isMounted) return;
        setState("success");
        setMessage(response.message || "Email verified successfully.");
      } catch (error) {
        if (!isMounted) return;
        setState("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "Unable to verify this email address.",
        );
      }
    };

    verifyEmail();

    return () => {
      isMounted = false;
    };
  }, [token]);

  const icon =
    state === "loading" ? (
      <Loader2 className="h-10 w-10 animate-spin text-blue-600 dark:text-blue-400" />
    ) : state === "success" ? (
      <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
    ) : (
      <XCircle className="h-10 w-10 text-red-600 dark:text-red-400" />
    );

  return (
    <main className="flex min-h-[60vh] items-center justify-center">
      <section className="w-full max-w-md rounded-lg bg-white p-8 text-center shadow-md dark:bg-slate-800">
        <div className="mb-4 flex justify-center">{icon}</div>
        <h1 className="mb-3 text-2xl font-bold text-gray-900 dark:text-white">
          Email Verification
        </h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-slate-300">
          {message}
        </p>
        {state !== "loading" && (
          <Link
            to="/login"
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
          >
            Go to login
          </Link>
        )}
      </section>
    </main>
  );
};

export default VerifyEmail;
