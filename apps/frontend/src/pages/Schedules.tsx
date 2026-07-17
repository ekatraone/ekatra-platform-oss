import Sidebar from "@/components/dashboard/Sidebar";
import ScheduleManager from "@/components/dashboard/ScheduleManager";
import PushMonitor from "@/components/dashboard/PushMonitor";

const Schedules = () => {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto py-6 px-4 md:px-6">
          <header className="mb-6">
            <h1 className="text-2xl font-bold">Schedule Management</h1>
            <p className="text-muted-foreground">
              Configure and monitor course delivery schedules
            </p>
          </header>

          <div className="space-y-6">
            <ScheduleManager />
            <PushMonitor />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Schedules;
