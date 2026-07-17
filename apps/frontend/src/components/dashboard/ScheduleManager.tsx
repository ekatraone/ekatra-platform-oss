import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";
import { Plus, Play, Pause, Settings } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { api } from "@/services/apiClient";

const scheduleFormSchema = z.object({
  courseId: z.string().min(1, "Course ID is required"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
  timezone: z.string().min(1, "Timezone is required"),
  days: z.array(z.number()).min(1, "Select at least one day"),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const ScheduleManager = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]); // Weekdays by default

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      courseId: "",
      time: "09:00",
      timezone: "Asia/Kolkata",
      days: [1, 2, 3, 4, 5],
    },
  });

  // Fetch schedules
  const { data: schedulesData, isLoading } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.getSchedules(),
  });

  const schedules: any[] = Array.isArray(schedulesData) ? schedulesData : (schedulesData as any)?.data || [];

  // Fetch courses for dropdown
  const { data: coursesData } = useQuery({
    queryKey: ["courses"],
    queryFn: () => api.getCourses({ limit: 100 }),
  });

  const courses: any[] = Array.isArray(coursesData) ? coursesData : (coursesData as any)?.data || (coursesData as any)?.courses || [];

  // Create schedule mutation
  const createScheduleMutation = useMutation({
    mutationFn: (data: ScheduleFormValues) =>
      api.createSchedule({
        courseId: data.courseId,
        schedule: `${data.time} ${data.timezone}`,
        timezone: data.timezone,
        daysOfWeek: data.days,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setIsDialogOpen(false);
      form.reset();
      toast({
        title: "Success",
        description: "Schedule created successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Update schedule mutation (pause/resume)
  const updateScheduleMutation = useMutation({
    mutationFn: ({ id, isPaused }: { id: string; isPaused: boolean }) =>
      api.updateSchedule(id, { isPaused }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      toast({
        title: "Success",
        description: "Schedule updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Trigger push mutation
  const triggerPushMutation = useMutation({
    mutationFn: (scheduleId: string) => api.triggerPush(scheduleId),
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Push triggered successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (data: ScheduleFormValues) => {
    createScheduleMutation.mutate(data);
  };

  const toggleSchedule = (id: string, currentlyPaused: boolean) => {
    updateScheduleMutation.mutate({ id, isPaused: !currentlyPaused });
  };

  const triggerManualPush = (scheduleId: string) => {
    triggerPushMutation.mutate(scheduleId);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Course Schedules</CardTitle>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Schedule
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Schedule</DialogTitle>
                <DialogDescription>
                  Set up a recurring schedule for course delivery
                </DialogDescription>
              </DialogHeader>

              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="courseId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Course</FormLabel>
                        <FormControl>
                          <select
                            {...field}
                            className="w-full px-3 py-2 border rounded-md"
                          >
                            <option value="">Select a course</option>
                            {courses.map((course: any) => (
                              <option key={course.id} value={course.id}>
                                {course.title}
                              </option>
                            ))}
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="time"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Time (HH:MM)</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="09:00" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="timezone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Timezone</FormLabel>
                        <FormControl>
                          <select
                            {...field}
                            className="w-full px-3 py-2 border rounded-md"
                          >
                            <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                            <option value="America/New_York">America/New_York (EST)</option>
                            <option value="Europe/London">Europe/London (GMT)</option>
                            <option value="Asia/Tokyo">Asia/Tokyo (JST)</option>
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div>
                    <FormLabel>Days of Week</FormLabel>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {WEEKDAYS.map((day) => (
                        <Button
                          key={day.value}
                          type="button"
                          variant={selectedDays.includes(day.value) ? "default" : "outline"}
                          size="sm"
                          onClick={() => {
                            const newDays = selectedDays.includes(day.value)
                              ? selectedDays.filter((d) => d !== day.value)
                              : [...selectedDays, day.value];
                            setSelectedDays(newDays);
                            form.setValue("days", newDays);
                          }}
                        >
                          {day.label.slice(0, 3)}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <DialogFooter>
                    <Button type="submit" disabled={createScheduleMutation.isPending}>
                      {createScheduleMutation.isPending ? "Creating..." : "Create Schedule"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p>Loading schedules...</p>
        ) : schedules.length === 0 ? (
          <p className="text-muted-foreground">No schedules configured</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Next Run</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule: any) => (
                <TableRow key={schedule.id}>
                  <TableCell>{schedule.courseTitle || schedule.courseId}</TableCell>
                  <TableCell>{schedule.schedule}</TableCell>
                  <TableCell>
                    <Badge variant={schedule.isPaused ? "secondary" : "default"}>
                      {schedule.isPaused ? "Paused" : "Active"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {schedule.nextRun
                      ? new Date(schedule.nextRun).toLocaleString()
                      : "N/A"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggleSchedule(schedule.id, schedule.isPaused)}
                      >
                        {schedule.isPaused ? (
                          <Play className="h-4 w-4" />
                        ) : (
                          <Pause className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => triggerManualPush(schedule.id)}
                        disabled={triggerPushMutation.isPending}
                      >
                        <Play className="h-4 w-4 mr-1" />
                        Trigger
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
};

export default ScheduleManager;
