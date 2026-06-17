import { Thread } from "@/components/thread";
import { FindMyJobWorkbench } from "@/components/findmyjob-workbench";

export default function App() {
  return (
    <div className="min-h-screen bg-background workbench-shell">
      <Thread />
      <FindMyJobWorkbench />
    </div>
  );
}
