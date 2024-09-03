import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/* ------------------------------ prerequisite ------------------------------ */

const stack = pulumi.getStack();
const org = pulumi.getOrganization();

const stackReference = new pulumi.StackReference(`${org}/authentication/${stack}`);
const config = new pulumi.Config();

/* --------------------------------- config --------------------------------- */

const NS = stack
const GRAFANA_CLIENT_SECRET =
    stackReference.requireOutput("grafanaRealmSecret") as pulumi.Output<string>;
const HOST = config.require("HOST");

/* --------------------------------- Grafana -------------------------------- */

new k8s.helm.v3.Chart("grafana", {
    namespace: NS,
    chart: "grafana",
    fetchOpts: {
        repo: "https://grafana.github.io/helm-charts",
    },
    values: {
        // https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/keycloak/
        assertNoLeakedSecrets: false,
        "grafana.ini": {
            auth: {
                disable_login_form: true
            },
            "auth.generic_oauth": {
                enabled: true,
                name: "Keycloak-OAuth",
                allow_sign_up: true,
                client_id: "grafana",
                client_secret: GRAFANA_CLIENT_SECRET,
                scopes: "openid email profile offline_access roles",
                email_attribute_path: "email",
                login_attribute_path: "username",
                name_attribute_path: "full_name",
                auth_url: `https://${HOST}/keycloak/realms/ctf/protocol/openid-connect/auth`,
                token_url: `http://keycloak:8080/realms/ctf/protocol/openid-connect/token`,
                api_url: `https://${HOST}/keycloak/realms/ctf/protocol/openid-connect/userinfo`,
                //signout_redirect_url: "https://<PROVIDER_DOMAIN>/auth/realms/<REALM_NAME>/protocol/openid-connect/logout?post_logout_redirect_uri=https%3A%2F%2F<GRAFANA_DOMAIN>%2Flogin",
                role_attribute_path: "contains(roles[*], 'admin') && 'Admin' || contains(roles[*], 'editor') && 'Editor' || 'Viewer'"
            },
            server: {
                root_url: `https://${HOST}/grafana/`
            }
        },
        datasources: {
            "datasources.yaml": {
                apiVersion: 1,
                datasources: [
                    {
                        name: "Prometheus",
                        type: "prometheus",
                        url: "http://kube-prometheus-stack-prometheus:9090",
                        access: "proxy"
                    },
                    {
                        name: "Loki",
                        type: "loki",
                        url: "http://loki-gateway",
                        access: "proxy"
                    }
                ]
            }
        },
        dashboardProviders: {
            "dashboardproviders.yaml": {
                apiVersion: 1,
                providers: [
                    {
                        name: 'grafana-dashboards-kubernetes',
                        orgId: 1,
                        folder: 'Kubernetes',
                        type: "file",
                        disableDeletion: true,
                        editable: true,
                        options: {
                            path: "/var/lib/grafana/dashboards/grafana-dashboards-kubernetes"
                        }
                    },
                    {
                        name: 'grafana-dashboards-node',
                        orgId: 1,
                        folder: 'Node',
                        type: "file",
                        disableDeletion: true,
                        editable: true,
                        options: {
                            path: "/var/lib/grafana/dashboards/grafana-dashboards-node"
                        }
                    }
                ]
            }
        },
        dashboards: {
            // https://github.com/dotdc/grafana-dashboards-kubernetes
            "grafana-dashboards-kubernetes": {
                "k8s-addons-prometheus": {
                    gnetId: 19105,
                    revision: 3,
                    datasource: "Prometheus"
                },
                "k8s-addons-trivy-operator": {
                    gnetId: 16337,
                    revision: 12,
                    datasource: "Prometheus"
                },
                "k8s-system-api-server": {
                    gnetId: 15761,
                    revision: 17,
                    datasource: "Prometheus"
                },
                "k8s-system-coredns": {
                    gnetId: 15762,
                    revision: 18,
                    datasource: "Prometheus"
                },
                "k8s-views-global": {
                    gnetId: 15757,
                    revision: 37,
                    datasource: "Prometheus"
                },
                "k8s-views-namespaces": {
                    gnetId: 15758,
                    revision: 35,
                    datasource: "Prometheus"
                },
                "k8s-views-nodes": {
                    gnetId: 15759,
                    revision: 29,
                    datasource: "Prometheus"
                },
                "k8s-views-pods": {
                    gnetId: 15760,
                    revision: 29,
                    datasource: "Prometheus"
                }
            },
            "grafana-dashboards-node": {
                "node-exporter-full": {
                    gnetId: 1860,
                    revision: 37,
                    datasource: "Prometheus"
                }
            }
        },
        ingress: {
            enabled: true,
            ingressClassName: "nginx",
            path: "/grafana(/|$)(.*)",
            pathType: "ImplementationSpecific",
            hosts: [HOST],
            annotations: {
                "nginx.ingress.kubernetes.io/rewrite-target": "/$2",
            }
        }
    }
});

/* -------------------------- kube-prometheus-stack ------------------------- */

new k8s.helm.v3.Chart("kube-prometheus-stack", {
    namespace: NS,
    chart: "kube-prometheus-stack",
    fetchOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    // Includes scraping for cAdvisor
    // Dependencies listed for easy disabling
    values: {
        crds: {
            enabled: true
        },
        prometheus: {
            enabled: true
        },
        alertmanager: {
            enabled: false
        },
        grafana: {
            enabled: false
        },
        kubeStateMetrics: {
            enabled: true
        },
        nodeExporter: {
            enabled: true
        },
        windowsMonitoring: {
            enabled: true
        },
        // https://github.com/dotdc/grafana-dashboards-kubernetes?tab=readme-ov-file#known-issues
        "prometheus-node-exporter": {
            prometheus: {
                monitor: {
                    relabelings: [
                        {
                            action: "replace",
                            sourceLabels: [
                                "__meta_kubernetes_pod_node_name"
                            ],
                            targetLabel: "nodename"
                        }
                    ]
                }
            }
        }
    },
});

/* ---------------------------------- Loki ---------------------------------- */

new k8s.helm.v3.Chart("loki", {
    namespace: NS,
    chart: "loki",
    fetchOpts: {
        repo: "https://grafana.github.io/helm-charts",
    },
    values: {
        // https://grafana.com/docs/loki/latest/setup/install/helm/install-monolithic/
        deploymentMode: "SingleBinary",
        loki: {
            auth_enabled: false,
            commonConfig: {
                replication_factor: 1
            },
            storage: {
                type: "filesystem"
            },
            schemaConfig: {
                configs: [
                    {
                        from: "2024-01-01",
                        store: "tsdb",
                        index: {
                            prefix: "loki_index_",
                            period: "24h"
                        },
                        object_store: "filesystem",
                        schema: "v13"
                    }
                ]
            }
        },
        // TODO What is this?
        singleBinary: {
            replicas: 1
        },
        read: {
            replicas: 0
        },
        backend: {
            replicas: 0
        },
        write: {
            replicas: 0
        }
    },
});

/* -------------------------------- Promtail -------------------------------- */

new k8s.helm.v3.Chart("promtail", {
    namespace: NS,
    chart: "promtail",
    fetchOpts: {
        repo: "https://grafana.github.io/helm-charts",
    }
});