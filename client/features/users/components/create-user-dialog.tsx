"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle, TriangleAlert, UserPlus } from "lucide-react";
import { useId, useState } from "react";
import { Controller, useForm, useFormState, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CREATE_USER_FIELDS, describeCreateUserFailure } from "../errors";
import { NO_PASSWORD_NOTE, ROLE_DESCRIPTIONS, ROLE_LABELS } from "../labels";
import { useCreateUser } from "../mutations";
import {
  DEFAULT_NEW_USER_ROLE,
  toUserCreate,
  USER_EMAIL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
  userCreateSchema,
  type UserCreateInput,
} from "../schemas";
import { RoleSelect } from "./role-select";

type CreateUser = ReturnType<typeof useCreateUser>;

interface CreateUserFormProps {
  create: CreateUser;
  formId: string;
  onCreated: () => void;
  onCancel: () => void;
}

const DEFAULT_VALUES: UserCreateInput = {
  email: "",
  name: "",
  role: DEFAULT_NEW_USER_ROLE,
  password: "",
};

function CreateUserForm({ create, formId, onCreated, onCancel }: CreateUserFormProps) {
  const form = useForm<UserCreateInput>({
    resolver: zodResolver(userCreateSchema),
    defaultValues: DEFAULT_VALUES,
  });
  const { errors } = useFormState({ control: form.control });
  const role = useWatch({ control: form.control, name: "role" });
  const [formError, setFormError] = useState<string | null>(null);
  const nameId = `${formId}-name`;
  const emailId = `${formId}-email`;
  const roleId = `${formId}-role`;
  const passwordId = `${formId}-password`;
  const passwordHelpId = `${passwordId}-help`;

  function submit(values: UserCreateInput): void {
    setFormError(null);
    create.mutate(toUserCreate(values), {
      onSuccess: (user) => {
        toast.success(`${user.name} added as ${ROLE_LABELS[user.role]}`);
        onCreated();
      },
      onError: (error) => {
        const failure = describeCreateUserFailure(error);
        for (const field of CREATE_USER_FIELDS) {
          const message = failure.fieldMessages[field];
          if (message !== undefined) {
            form.setError(field, { type: "server", message });
          }
        }
        setFormError(failure.message);
      },
      onSettled: () => form.resetField("password", { keepError: true }),
    });
  }

  return (
    <form
      id={formId}
      aria-label="New user"
      noValidate
      autoComplete="off"
      onSubmit={form.handleSubmit(submit)}
      data-slot="create-user-form"
      className="grid min-w-0 gap-4"
    >
      <DialogHeader>
        <DialogTitle>New user</DialogTitle>
        <DialogDescription>
          Create an account and choose what the person can do. You can change the role or
          deactivate the account later.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {formError !== null ? (
          <Alert variant="destructive" data-slot="create-user-failure">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Could not create the user</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            autoComplete="off"
            maxLength={USER_NAME_MAX_LENGTH}
            aria-invalid={errors.name ? true : undefined}
            {...form.register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={errors.email ? true : undefined}>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>
          <Input
            id={emailId}
            type="email"
            autoComplete="off"
            maxLength={USER_EMAIL_MAX_LENGTH}
            aria-invalid={errors.email ? true : undefined}
            {...form.register("email")}
          />
          <FieldError errors={[errors.email]} />
        </Field>
        <Field data-invalid={errors.role ? true : undefined}>
          <FieldLabel htmlFor={roleId}>Role</FieldLabel>
          <Controller
            control={form.control}
            name="role"
            render={({ field }) => (
              <RoleSelect
                id={roleId}
                label="Role"
                value={field.value}
                onValueChange={field.onChange}
                triggerRef={field.ref}
                onBlur={field.onBlur}
                invalid={errors.role !== undefined}
                className="w-full sm:w-48"
              />
            )}
          />
          <FieldDescription>{ROLE_DESCRIPTIONS[role]}</FieldDescription>
          <FieldError errors={[errors.role]} />
        </Field>
        <Field data-invalid={errors.password ? true : undefined}>
          <FieldLabel htmlFor={passwordId}>Password (optional)</FieldLabel>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={passwordHelpId}
            {...form.register("password")}
          />
          <FieldDescription id={passwordHelpId} data-slot="no-password-note">
            {NO_PASSWORD_NOTE} A password needs at least {USER_PASSWORD_MIN_LENGTH} characters.
          </FieldDescription>
          <FieldError errors={[errors.password]} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={create.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending} aria-busy={create.isPending}>
          {create.isPending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          {create.isPending ? "Creating" : "Create user"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function CreateUserDialog() {
  const formId = useId();
  const create = useCreateUser();
  const [open, setOpen] = useState(false);

  function handleOpenChange(next: boolean): void {
    if (!next && create.isPending) {
      return;
    }
    if (next) {
      create.reset();
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" data-slot="create-user-trigger">
          <UserPlus aria-hidden="true" data-icon="inline-start" />
          New user
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <CreateUserForm
          create={create}
          formId={formId}
          onCreated={() => setOpen(false)}
          onCancel={() => handleOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
