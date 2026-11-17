import { SportsbookBoardPage } from "@/components/sportsbook/board-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sports — PlutoBet" };

export default async function SportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  return (
    <SportsbookBoardPage
      sport={one("sport") ?? "football"}
      league={one("league")}
      when={one("when")}
      q={one("q")}
    />
  );
}
