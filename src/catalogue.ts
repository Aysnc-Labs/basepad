import type { z } from "zod";
import { mailpitKind } from "./catalogue/mailpit.ts";
import { postgresKind, postgresWithNeonProxyKind } from "./catalogue/postgres.ts";
import { redisKind } from "./catalogue/redis.ts";
import type { Machine } from "./layout.ts";
import type { Daemon } from "./supervisor.ts";

export interface ServiceBase {
	kind: string;
}

export interface NameInput {
	name: string;
	key: string;
	dir: string;
	suffix?: string;
}

export type Place<N = unknown> = {
	name: string;
	key: string;
	owner: string;
	suffix?: string;
	dir: string;
	port: number;
	daemon: string;
	web?: Web;
	extraDaemons: Record<string, ExtraDaemon>;
	machine: Machine;
} & N;

export interface Web {
	host: string;
	url: string;
	port: number;
}

export interface ExtraDaemon {
	daemon: string;
	port: number;
	pid: string;
}

export interface WorktreeData {
	name: string;
	owner: string;
}

export interface Kind<S extends ServiceBase, O, N> {
	schema: z.ZodType<S>;
	web?: true;
	extraDaemons?: readonly string[];
	perEnvironment?(service: S): boolean;
	names(service: S, input: NameInput): N;
	prepare(service: S, place: Place<N>): Promise<Record<string, Daemon>>;
	provision(
		service: S,
		place: Place<N>,
		options: {
			claim: boolean;
			started: boolean;
			stopped: () => Promise<boolean>;
			print(line: string): void;
		},
	): Promise<O>;
	worktreeData?: WorktreeDataStore<S, N>;
	address(service: S, place: Place<N>): Promise<string>;
	extraAddress?(place: Place<N>, extra: string): Promise<string>;
	database?: Database<S, N>;
}

export interface WorktreeDataStore<S, N> {
	list(service: S, place: Place<N>): Promise<WorktreeData[]>;
	drop(service: S, place: Place<N>, names: string[]): Promise<void>;
}

export interface Snapshot {
	label: string;
	database: string;
	bytes: number;
	invalid?: true;
}

export interface Database<S, N> {
	save(service: S, place: Place<N>, label: string, validated: Validated): Promise<void>;
	load(service: S, place: Place<N>, label: string, validated: Validated): Promise<void>;
	snapshots(service: S, place: Place<N>): Promise<Snapshot[]>;
	remove(service: S, place: Place<N>, label: string, validated: Validated): Promise<void>;
	import(
		service: S,
		place: Place<N>,
		source: string,
		confirm: (database: string) => Promise<void>,
	): Promise<string>;
	export(
		service: S,
		place: Place<N>,
		file: string | undefined,
		validated: Validated,
	): Promise<string>;
}

export type Validated = () => Promise<void>;

const CATALOGUE = {
	postgres: postgresKind,
	postgresWithNeonProxy: postgresWithNeonProxyKind,
	redis: redisKind,
	mailpit: mailpitKind,
};
type Catalogue = typeof CATALOGUE;

/** Something basepad provides to an environment: one config entry of a kind in the catalogue. */
export type Service = {
	[K in keyof Catalogue]: Catalogue[K] extends { schema: z.ZodType<infer S> } ? S : never;
}[keyof Catalogue];

export type OutputsOf<S extends Service> = Catalogue[S["kind"]] extends {
	provision(...args: never[]): Promise<infer O>;
}
	? O
	: never;

export type NamesOf<S extends Service> = ReturnType<Catalogue[S["kind"]]["names"]>;

export function kindOf<S extends Service>(service: S): Kind<S, OutputsOf<S>, NamesOf<S>> {
	return CATALOGUE[service.kind] as unknown as Kind<S, OutputsOf<S>, NamesOf<S>>;
}

export const EXTRA_DAEMONS: readonly string[] = [
	...new Set(
		Object.values(CATALOGUE).flatMap(
			(kind: { extraDaemons?: readonly string[] }) => kind.extraDaemons ?? [],
		),
	),
];

export const SCHEMAS: z.ZodType<Service>[] = Object.values(CATALOGUE).map((kind) => kind.schema);

export const FACTORIES: string[] = Object.keys(CATALOGUE).map((kind) => `\`${kind}()\``);
