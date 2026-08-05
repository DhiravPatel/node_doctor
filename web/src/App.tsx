import { useHashRoute } from "./router.tsx";
import { Nav } from "./components/Nav.tsx";
import { Footer } from "./components/Footer.tsx";
import { Home } from "./pages/Home.tsx";
import { RulesPage } from "./pages/RulesPage.tsx";
import { CiPage } from "./pages/CiPage.tsx";
import { AgentPage } from "./pages/AgentPage.tsx";
import { InstallPage } from "./pages/InstallPage.tsx";

const routeToPage = (route: string) => {
  if (route.startsWith("/diagnostics")) return <RulesPage />;
  if (route.startsWith("/ci")) return <CiPage />;
  if (route.startsWith("/agent")) return <AgentPage />;
  if (route.startsWith("/install")) return <InstallPage />;
  return <Home />;
};

export function App() {
  const route = useHashRoute();
  return (
    <>
      <div className="bg-dots" />
      <div className="grain" />
      <Nav route={route.startsWith("/diagnostics") ? "/diagnostics" : route.startsWith("/ci") ? "/ci" : route.startsWith("/agent") ? "/agent" : route.startsWith("/install") ? "/install" : "/"} />
      <main key={route}>{routeToPage(route)}</main>
      <Footer />
    </>
  );
}
