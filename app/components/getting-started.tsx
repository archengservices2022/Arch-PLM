import { allStepsDone, type GettingStartedStep } from "../lib/getting-started-core.ts";

/** Dashboard "Start here" panel: the four first steps, ticked when done.
 *  Open while a step is open; folded (still clickable) once all are done. */
export function GettingStarted({ steps }: { steps: GettingStartedStep[] }) {
  const finished = allStepsDone(steps);
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <details
      open={!finished}
      className="rounded-lg border border-teal-300 bg-teal-50 px-5 py-4"
    >
      <summary className="cursor-pointer text-base font-semibold text-teal-900">
        Start here · {doneCount} of {steps.length} steps done
      </summary>
      <ol className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <li
            key={step.key}
            className={`rounded-md border bg-white p-3 ${step.done ? "border-teal-300" : "border-slate-300"}`}
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                  step.done ? "bg-teal-700 text-white" : "bg-slate-200 text-slate-700"
                }`}
              >
                {step.done ? "✓" : index + 1}
              </span>
              {step.title}
              {step.done ? <span className="sr-only">(done)</span> : null}
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-600">{step.hint}</p>
            {!step.done ? (
              <a
                href={step.href}
                className="mt-2 inline-block text-xs font-semibold text-teal-800 underline"
              >
                Go there
              </a>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
