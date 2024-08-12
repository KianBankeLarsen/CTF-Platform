import { Service } from "@pulumi/kubernetes/core/v1";
import { Input, Output } from "@pulumi/pulumi";

interface Port {
    port: number,
    targetPort?: number,
    name?: string,
    protocol?: string
}

export function serviceTemplate(
    resource: string,
    ns: Output<string> | string,
    ports: Port[],
    selector: Record<string, Input<string>>
) {
    return new Service(resource, {
        metadata: {
            namespace: ns
        },
        spec: {
            ports: ports,
            selector: selector
        },
    });
}