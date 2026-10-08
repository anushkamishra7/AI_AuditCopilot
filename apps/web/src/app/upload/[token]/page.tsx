import type { Metadata } from "next";
import { LinkProblem } from "@/components/upload/link-problem";
import { RequestUpload } from "@/components/upload/request-upload";
import { lookupUploadToken } from "@/lib/api";

export const metadata: Metadata = {
  title: "Evidence request",
};

// Public, unauthenticated route — the token is the only credential. No Clerk
// session, no sidebar (this file sits outside the /engagements layout tree).
export default async function UploadPage(props: PageProps<"/upload/[token]">) {
  const { token } = await props.params;
  const resolution = await lookupUploadToken(token);

  if (resolution.kind === "invalid") {
    return <LinkProblem variant="invalid" />;
  }

  if (resolution.kind === "expired") {
    return <LinkProblem variant="expired" auditor={resolution.auditor} />;
  }

  return (
    <RequestUpload
      token={token}
      request={resolution.request}
      stakeholder={resolution.stakeholder}
      auditor={resolution.auditor}
    />
  );
}
