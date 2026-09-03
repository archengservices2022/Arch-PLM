import { LifecycleState, ItemType } from "@/app/generated/prisma/enums";
import { advanceRevision, createItem } from "@/app/actions";
import { prisma } from "@/app/lib/prisma";
import { requireDashboardActor, type Actor } from "@/app/lib/authz";
import { signOut } from "@/auth";

export const dynamic = "force-dynamic";

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

async function getDashboardData(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      users: { orderBy: { name: "asc" } },
      customers: { orderBy: { name: "asc" } },
    },
  });

  if (!organization) {
    return {
      organization: null,
      projects: [],
      items: [],
      lifecycleCounts: emptyLifecycleCounts(),
      openRevisions: [],
    };
  }

  const [projects, items, revisions] = await Promise.all([
    prisma.project.findMany({
      where: { organizationId: organization.id },
      orderBy: { projectNumber: "asc" },
      include: { customer: true },
    }),
    prisma.item.findMany({
      where: { organizationId: organization.id },
      orderBy: { itemNumber: "asc" },
      include: {
        project: true,
        revisions: {
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    prisma.itemRevision.findMany({
      where: { item: { organizationId: organization.id } },
      orderBy: [{ lifecycle: "asc" }, { updatedAt: "desc" }],
      include: { item: true },
    }),
  ]);

  const lifecycleCounts = revisions.reduce((counts, revision) => {
    counts[revision.lifecycle] += 1;
    return counts;
  }, emptyLifecycleCounts());
  const openRevisions = revisions.filter(
    (revision) =>
      revision.lifecycle !== LifecycleState.RELEASED &&
      revision.lifecycle !== LifecycleState.OBSOLETE &&
      revision.lifecycle !== LifecycleState.SUPERSEDED,
  );

  return {
    organization,
    projects,
    items,
    lifecycleCounts,
    openRevisions,
  };
}

function emptyLifecycleCounts() {
  return Object.values(LifecycleState).reduce(
    (counts, state) => ({ ...counts, [state]: 0 }),
    {} as Record<LifecycleState, number>,
  );
}

type DashboardData =
  | ({ status: "ready" } & Awaited<ReturnType<typeof getDashboardData>>)
  | {
      status: "unavailable";
      message: string;
    };

async function loadDashboard(organizationId: string): Promise<DashboardData> {
  try {
    const data = await getDashboardData(organizationId);
    return { status: "ready", ...data };
  } catch (error) {
    return {
      status: "unavailable",
      message:
        error instanceof Error
          ? error.message
          : "The PLM database is not reachable yet.",
    };
  }
}

const lifecycleOrder = [
  LifecycleState.WORKING,
  LifecycleState.IN_REVIEW,
  LifecycleState.APPROVED,
  LifecycleState.RELEASED,
  LifecycleState.SUPERSEDED,
  LifecycleState.OBSOLETE,
];

export default async function Home() {
  const actor = await requireDashboardActor();
  const dashboard = await loadDashboard(actor.organizationId);

  if (dashboard.status === "unavailable") {
    return (
      <main className="min-h-screen bg-stone-100 px-6 py-10 text-slate-950">
        <section className="mx-auto flex max-w-3xl flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
              Arch PLM
            </p>
            <SessionBar actor={actor} />
          </div>
          <h1 className="text-4xl font-semibold tracking-normal">
            The PLM workspace is temporarily unavailable.
          </h1>
          <p className="text-base leading-7 text-slate-700">{dashboard.message}</p>
        </section>
      </main>
    );
  }

  const { organization, projects, items, lifecycleCounts, openRevisions } = dashboard;

  return (
    <main className="min-h-screen bg-stone-100 text-slate-950">
      <section className="border-b border-slate-300 bg-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-6 py-8 lg:grid-cols-[1fr_360px]">
          <div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
                Arch PLM Core
              </p>
              <SessionBar actor={actor} />
            </div>
            <h1 className="mt-3 text-4xl font-semibold tracking-normal">
              {organization?.name ?? "No workspace yet"}
            </h1>
            <p className="mt-3 max-w-3xl text-base leading-7 text-slate-700">
              Engineering item control across customers, projects, permanent item
              identities, and revision lifecycle states.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Projects" value={projects.length} />
            <Metric label="Items" value={items.length} />
            <Metric label="Customers" value={organization?.customers.length ?? 0} />
            <Metric label="Users" value={organization?.users.length ?? 0} />
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-6 py-6 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-6">
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {lifecycleOrder.map((state) => (
              <Metric
                key={state}
                label={formatState(state)}
                value={lifecycleCounts[state]}
              />
            ))}
          </div>

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold">Item master</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-5 py-3">Item</th>
                    <th className="px-5 py-3">Type</th>
                    <th className="px-5 py-3">Project</th>
                    <th className="px-5 py-3">Latest revision</th>
                    <th className="px-5 py-3">State</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const latestRevision = item.revisions[0];

                    return (
                      <tr key={item.id} className="border-t border-slate-200">
                        <td className="px-5 py-4">
                          <p className="font-semibold">{item.itemNumber}</p>
                          <p className="mt-1 text-slate-600">{item.description}</p>
                        </td>
                        <td className="px-5 py-4">{formatState(item.type)}</td>
                        <td className="px-5 py-4 text-slate-700">
                          {item.project?.projectNumber ?? "Unassigned"}
                        </td>
                        <td className="px-5 py-4">{latestRevision?.revision ?? "-"}</td>
                        <td className="px-5 py-4">
                          {latestRevision ? <StateBadge state={latestRevision.lifecycle} /> : "-"}
                        </td>
                      </tr>
                    );
                  })}
                  {items.length === 0 ? (
                    <tr>
                      <td className="px-5 py-8 text-slate-600" colSpan={5}>
                        No items have been created yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="text-lg font-semibold">Revision work queue</h2>
            </div>
            <div className="divide-y divide-slate-200">
              {openRevisions.map((revision) => (
                <form
                  key={revision.id}
                  action={advanceRevision}
                  className="grid gap-3 px-5 py-4 md:grid-cols-[1fr_190px_120px]"
                >
                  <input type="hidden" name="revisionId" value={revision.id} />
                  <div>
                    <p className="font-semibold">
                      {revision.item.itemNumber} Rev {revision.revision}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {revision.description ?? revision.item.description}
                    </p>
                  </div>
                  <select
                    name="lifecycle"
                    defaultValue={revision.lifecycle}
                    className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                  >
                    {lifecycleOrder.map((state) => (
                      <option key={state} value={state}>
                        {formatState(state)}
                      </option>
                    ))}
                  </select>
                  <button className="h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800">
                    Update
                  </button>
                </form>
              ))}
              {openRevisions.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-600">
                  No open revision work is waiting.
                </p>
              ) : null}
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <section className="rounded-lg border border-slate-300 bg-white p-5">
            <h2 className="text-lg font-semibold">Create item</h2>
            <form action={createItem} className="mt-5 flex flex-col gap-4">
              <Field label="Item number" name="itemNumber" placeholder="10073-MFD-BR018" />
              <Field label="Description" name="description" placeholder="Bearing support bracket" />
              <label className="flex flex-col gap-2 text-sm font-medium">
                Type
                <select
                  name="type"
                  defaultValue={ItemType.PART}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                >
                  {Object.values(ItemType).map((type) => (
                    <option key={type} value={type}>
                      {formatState(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                Project
                <select
                  name="projectId"
                  defaultValue={projects[0]?.id ?? ""}
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                >
                  <option value="">Unassigned</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.projectNumber} - {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-[92px_1fr] gap-3">
                <Field label="Rev" name="revision" placeholder="A" />
                <Field
                  label="Revision note"
                  name="revisionDescription"
                  placeholder="Initial design baseline"
                />
              </div>
              <button className="h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800">
                Add item
              </button>
            </form>
          </section>

          <section className="rounded-lg border border-slate-300 bg-white p-5">
            <h2 className="text-lg font-semibold">Projects</h2>
            <div className="mt-4 flex flex-col gap-3">
              {projects.map((project) => (
                <div key={project.id} className="border-b border-slate-200 pb-3 last:border-0">
                  <p className="font-semibold">{project.projectNumber}</p>
                  <p className="text-sm text-slate-700">{project.name}</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">
                    {project.customer?.name ?? "No customer"}
                  </p>
                </div>
              ))}
              {projects.length === 0 ? (
                <p className="text-sm text-slate-600">
                  No projects exist in this workspace yet.
                </p>
              ) : null}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

function SessionBar({ actor }: { actor: Actor }) {
  return (
    <div className="flex items-center gap-3 text-xs text-slate-600">
      <span className="text-right leading-tight">
        <span className="block font-semibold text-slate-800">
          {actor.name || actor.email}
        </span>
        <span className="block uppercase tracking-wide text-slate-500">
          {formatState(actor.role)}
        </span>
      </span>
      <form action={signOutAction}>
        <button className="h-8 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100">
          Sign out
        </button>
      </form>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </div>
  );
}

function StateBadge({ state }: { state: LifecycleState }) {
  const tone =
    state === LifecycleState.RELEASED
      ? "bg-emerald-100 text-emerald-800"
      : state === LifecycleState.IN_REVIEW
        ? "bg-amber-100 text-amber-800"
        : state === LifecycleState.APPROVED
          ? "bg-teal-100 text-teal-800"
          : "bg-slate-100 text-slate-700";

  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>
      {formatState(state)}
    </span>
  );
}

function Field({
  label,
  name,
  placeholder,
}: {
  label: string;
  name: string;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium">
      {label}
      <input
        className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-teal-700"
        name={name}
        placeholder={placeholder}
        required
      />
    </label>
  );
}

function formatState(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
