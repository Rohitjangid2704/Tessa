"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, LoaderCircle, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useForm, useFormState } from "react-hook-form";
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
import { describeApiError } from "@/lib/api/errors";
import type { PersonalTokenCreated } from "@/lib/api/types";
import { useCreateToken } from "../mutations";
import {
  isTokenLimitError,
  PERSONAL_TOKEN_LIMIT,
  readServerMaxDays,
  TOKEN_EXPIRY_DAYS_MAX,
  TOKEN_EXPIRY_DAYS_MIN,
  TOKEN_NAME_MAX_LENGTH,
  toPersonalTokenCreate,
  tokenCreateSchema,
  type TokenCreateInput,
} from "../schemas";
import { TokenOnce } from "./token-once";

type CreateToken = ReturnType<typeof useCreateToken>;

const DEFAULT_VALUES: TokenCreateInput = { name: "" };

interface CreateTokenFormProps {
  create: CreateToken;
  formId: string;
  onCreated: (created: PersonalTokenCreated) => void;
  onCancel: () => void;
}

function CreateTokenForm({ create, formId, onCreated, onCancel }: CreateTokenFormProps) {
  const form = useForm<TokenCreateInput>({
    resolver: zodResolver(tokenCreateSchema),
    defaultValues: DEFAULT_VALUES,
  });
  const { errors } = useFormState({ control: form.control });
  const [limitReached, setLimitReached] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [serverMaxDays, setServerMaxDays] = useState<number | null>(null);
  const nameId = `${formId}-name`;
  const expiryId = `${formId}-expiry`;
  const expiryHelpId = `${expiryId}-help`;

  async function submit(values: TokenCreateInput): Promise<void> {
    setLimitReached(false);
    setFormError(null);
    try {
      const created = await create.mutateAsync(toPersonalTokenCreate(values));
      create.reset();
      onCreated(created);
    } catch (error) {
      if (isTokenLimitError(error)) {
        setLimitReached(true);
        return;
      }
      const maxDays = readServerMaxDays(error);
      if (maxDays !== null) {
        setServerMaxDays(maxDays);
        form.setError("expires_in_days", {
          type: "server",
          message: `The server allows at most ${maxDays} days`,
        });
        return;
      }
      setFormError(describeApiError(error));
    }
  }

  const expiryMax = serverMaxDays ?? TOKEN_EXPIRY_DAYS_MAX;

  return (
    <form
      id={formId}
      aria-label="New personal token"
      noValidate
      autoComplete="off"
      onSubmit={form.handleSubmit(submit)}
      data-slot="create-token-form"
      className="grid min-w-0 gap-4"
    >
      <DialogHeader>
        <DialogTitle>New personal token</DialogTitle>
        <DialogDescription>
          A token lets Claude Code call Tessa as you, with your role. Give it a name that says
          where it will live.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {limitReached ? (
          <Alert variant="destructive" data-slot="token-limit-alert">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Token limit reached</AlertTitle>
            <AlertDescription>
              You can have {PERSONAL_TOKEN_LIMIT} active tokens at a time. Revoke one you no longer
              use, then create the new one.
            </AlertDescription>
          </Alert>
        ) : null}
        {formError !== null ? (
          <Alert variant="destructive" data-slot="create-token-failure">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Could not create the token</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            autoComplete="off"
            maxLength={TOKEN_NAME_MAX_LENGTH}
            aria-invalid={errors.name ? true : undefined}
            {...form.register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={errors.expires_in_days ? true : undefined}>
          <FieldLabel htmlFor={expiryId}>Expires after (days)</FieldLabel>
          <Input
            id={expiryId}
            type="number"
            inputMode="numeric"
            min={TOKEN_EXPIRY_DAYS_MIN}
            max={expiryMax}
            autoComplete="off"
            placeholder="Server default"
            aria-invalid={errors.expires_in_days ? true : undefined}
            aria-describedby={expiryHelpId}
            {...form.register("expires_in_days", {
              setValueAs: (value: unknown) =>
                value === "" || value === null || value === undefined ? undefined : Number(value),
            })}
          />
          <FieldDescription id={expiryHelpId}>
            {serverMaxDays === null
              ? "Leave empty for the server default. The server caps the lifetime."
              : `The server maximum is ${serverMaxDays} days.`}
          </FieldDescription>
          <FieldError errors={[errors.expires_in_days]} />
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
          {create.isPending ? "Creating" : "Create token"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function CreateTokenDialog() {
  const formId = useId();
  const create = useCreateToken();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<PersonalTokenCreated | null>(null);

  function handleOpenChange(next: boolean): void {
    if (!next && create.isPending) {
      return;
    }
    if (next) {
      create.reset();
    } else {
      setCreated(null);
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" data-slot="create-token-trigger">
          <KeyRound aria-hidden="true" data-icon="inline-start" />
          New token
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-lg"
        onInteractOutside={(event) => {
          if (created !== null) {
            event.preventDefault();
          }
        }}
      >
        {created === null ? (
          <CreateTokenForm
            create={create}
            formId={formId}
            onCreated={setCreated}
            onCancel={() => handleOpenChange(false)}
          />
        ) : (
          <TokenOnce
            tokenName={created.item.name}
            token={created.token}
            onDone={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
