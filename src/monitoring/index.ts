import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/* ------------------------------ prerequisite ------------------------------ */

const stack = pulumi.getStack();
const org = pulumi.getOrganization();

const stackReference = new pulumi.StackReference(`${org}/infrastructure/${stack}`);
const config = new pulumi.Config();

/* --------------------------------- config --------------------------------- */

const NS = stack
const GRAFANA_CLIENT_SECRET =
    stackReference.requireOutput("grafanaRealmSecret") as pulumi.Output<string>;
const GRAFANA_HOST = config.require("GRAFANA_HOST");
const KEYCLOAK_HOST = config.require("KEYCLOAK_HOST");
const KEYCLOAK_HTTP_RELATIVE_PATH = config.require("KEYCLOAK_HTTP_RELATIVE_PATH");
const GRAFANA_HTTP_RELATIVE_PATH = config.require("GRAFANA_HTTP_RELATIVE_PATH");
const PROMTAIL_VERSION = config.require("PROMTAIL_VERSION");
const LOKI_VERSION = config.require("LOKI_VERSION");
const GRAFANA_VERSION = config.require("GRAFANA_VERSION");
const WEBCONFIGFILE = config.require("WEBCONFIGFILE");
const KUBE_PROMETHEUS_STACK_VERSION = config.require("KUBE-PROMETHEUS-STACK_VERSION");
const kubePrometheusStackRelaseName = "kube-prometheus-stack"
const TLS_DURATION = config.require("TLS_DURATION");
const LOKI_LOG_RENTION = config.require("LOKI_LOG_RENTION");
const PROMETHEUS_RENTION = config.require("PROMETHEUS_RENTION");
const PROMETHEUS_REQUEST_STORAGE = config.require("PROMETHEUS_REQUEST_STORAGE");
const LOKI_REQUEST_STORAGE = config.require("LOKI_REQUEST_STORAGE");

// Remove trailing slash if it exists, but keep the root '/' intact
const cleanedGrafanaPath = (GRAFANA_HTTP_RELATIVE_PATH !== '/' && GRAFANA_HTTP_RELATIVE_PATH.endsWith('/')) 
  ? GRAFANA_HTTP_RELATIVE_PATH.slice(0, -1) 
  : GRAFANA_HTTP_RELATIVE_PATH;

// TODO Add prometheus relabelings

// secrets

const BACKEND_API_POSTGRESQL =
    stackReference.requireOutput("backendApiPostgresql") as pulumi.Output<string>;

const addClusterLabel = {
    action: "replace",
    targetLabel: "cluster",
    replacement: "SDU-CTF"
}

/* --------------------------------- Grafana -------------------------------- */

const grafanaIngressPathType = GRAFANA_HTTP_RELATIVE_PATH !== "/" ? "ImplementationSpecific" : "Prefix"
const grafanaIngressPath = GRAFANA_HTTP_RELATIVE_PATH !== "/" ? `${cleanedGrafanaPath}(/|$)(.*)` : "/"
const grafanaIngressAnnotations: {[key: string]: string} = {
    "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
    "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
    "cert-manager.io/issuer": "step-issuer",
    "cert-manager.io/issuer-kind": "StepClusterIssuer",
    "cert-manager.io/issuer-group": "certmanager.step.sm"
};

if (GRAFANA_HTTP_RELATIVE_PATH !== "/") {
    grafanaIngressAnnotations["nginx.ingress.kubernetes.io/rewrite-target"] = "/$2";
}

// TODO add keycloak dashboard
new k8s.helm.v3.Chart("grafana", {
    namespace: NS,
    version: GRAFANA_VERSION,
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
                use_pkce: true,
                allow_sign_up: true,
                use_refresh_token: true,
                role_attribute_strict: true,
                tls_skip_verify_insecure: false,
                tls_client_ca: "/var/run/autocert.step.sm/root.crt",
                client_secret: GRAFANA_CLIENT_SECRET,
                scopes: "openid",
                client_id: "grafana",
                name: "Keycloak-OAuth",
                name_attribute_path: "name",
                email_attribute_path: "email",
                id_token_attribute_name: "access_token",
                login_attribute_path: "preferred_username",
                token_url: `https://keycloak${KEYCLOAK_HTTP_RELATIVE_PATH}realms/ctf/protocol/openid-connect/token`,
                auth_url: `https://${KEYCLOAK_HOST}${KEYCLOAK_HTTP_RELATIVE_PATH}realms/ctf/protocol/openid-connect/auth`,
                api_url: `https://${KEYCLOAK_HOST}${KEYCLOAK_HTTP_RELATIVE_PATH}realms/ctf/protocol/openid-connect/userinfo`,
                signout_redirect_url: `https://${KEYCLOAK_HOST}${KEYCLOAK_HTTP_RELATIVE_PATH}realms/ctf/protocol/openid-connect/logout`,
                role_attribute_path: "contains(resource_access.grafana.roles, 'admin') && 'Admin' || contains(resource_access.grafana.roles, 'editor') && 'Editor' || contains(resource_access.grafana.roles, 'viewer') && 'Viewer' ||  ''"
            },
            server: {
                root_url: `https://${GRAFANA_HOST}${GRAFANA_HTTP_RELATIVE_PATH}`,
                protocol: "https",
                cert_key: "/var/run/autocert.step.sm/site.key",
                cert_file: "/var/run/autocert.step.sm/site.crt"
            }
        },
        podAnnotations: {
            "autocert.step.sm/name": `grafana.${NS}.svc.cluster.local`
        },
        readinessProbe: {
            httpGet: {
                path: "/api/health",
                port: 3000,
                scheme: "HTTPS"
            },
            initialDelaySeconds: 60,
            timeoutSeconds: 30,
            failureThreshold: 10
        },
        livenessProbe: {
            httpGet: {
                path: "/api/health",
                port: 3000,
                scheme: "HTTPS"
            },
            initialDelaySeconds: 60,
            timeoutSeconds: 30,
            failureThreshold: 10
        },
        datasources: {
            "datasources.yaml": {
                apiVersion: 1,
                datasources: [
                    {
                        name: "Prometheus",
                        type: "prometheus",
                        url: "https://kube-prometheus-stack-prometheus:9090",
                        access: "proxy",
                        jsonData: {
                            tlsAuthWithCACert: true
                        },
                        secureJsonData: {
                            tlsCACert: "$__file{/var/run/autocert.step.sm/root.crt}"
                        }
                    },
                    {
                        name: "Loki",
                        type: "loki",
                        url: "https://loki:3100",
                        access: "proxy",
                        jsonData: {
                            tlsAuthWithCACert: true,
                            tlsAuth: true
                        },
                        secureJsonData: {
                            tlsCACert: "$__file{/var/run/autocert.step.sm/root.crt}",
                            tlsClientKey: "$__file{/var/run/autocert.step.sm/site.key}",
                            tlsClientCert: "$__file{/var/run/autocert.step.sm/site.crt}"
                        }
                    },
                    // https://grafana.com/docs/grafana/latest/datasources/postgres/configure/
                    {
                        name: "Deployer Database",
                        type: "postgres",
                        url: "deployer-postgresql",
                        user: "postgres",
                        secureJsonData: {
                            password: BACKEND_API_POSTGRESQL
                        },
                        jsonData: {
                            database: "postgres",
                            sslmode: "disable",
                            maxOpenConns: 100, // Grafana v5.4+
                            maxIdleConns: 100, // Grafana v5.4+
                            maxIdleConnsAuto: true, // Grafana v9.5.1+
                            connMaxLifetime: 14400, // Grafana v5.4+
                            postgresVersion: 1600, // 903=9.3, 904=9.4, 905=9.5, 906=9.6, 1000=10
                            timescaledb: false
                        }
                    }
                ]
            }
        },
        sidecar: {
            dashboards: {
                enabled: true,
                provider: {
                    folder: "Kube Prometheus Stack"
                }
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
        serviceMonitor: {
            enabled: true,
            labels: {
                release: kubePrometheusStackRelaseName
            },
            metricRelabelings: [
                addClusterLabel
            ],
            scheme: "https",
            tlsConfig: {
                caFile: "/var/run/step/ca.crt",
                serverName: `grafana.${NS}.svc.cluster.local`,
                insecureSkipVerify: false
            }
        },
        ingress: {
            enabled: true,
            ingressClassName: "nginx",
            path: grafanaIngressPath,
            pathType: grafanaIngressPathType,
            hosts: [GRAFANA_HOST],
            annotations: grafanaIngressAnnotations,
            tls: [
                {
                    secretName: "grafana-tls",
                    hosts: [GRAFANA_HOST]
                }
            ]
        }
    }
});

/* -------------------------- kube-prometheus-stack ------------------------- */

const prometheusCert = new k8s.apiextensions.CustomResource("prometheus-inbound-tls", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "prometheus-inbound-tls",
        namespace: NS,
    },
    spec: {
        secretName: "prometheus-inbound-tls",
        commonName: `kube-prometheus-stack-prometheus.${NS}.svc.cluster.local`,
        dnsNames: [
            `kube-prometheus-stack-prometheus.${NS}.svc.cluster.local`,
            "kube-prometheus-stack-prometheus"
        ],
        issuerRef: {
            group: "certmanager.step.sm",
            kind: "StepClusterIssuer",
            name: "step-issuer",
        },
    },
});

const nodeExporterCert = new k8s.apiextensions.CustomResource("node-exporter-inbound-tls", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "node-exporter-inbound-tls",
        namespace: NS,
    },
    spec: {
        secretName: "node-exporter-inbound-tls",
        commonName: "kube-prometheus-stack-prometheus-node-exporter",
        dnsNames: [
            `kube-prometheus-stack-prometheus-node-exporter.${NS}.svc.cluster.local`,
            "kube-prometheus-stack-prometheus-node-exporter"
        ],
        issuerRef: {
            group: "certmanager.step.sm",
            kind: "StepClusterIssuer",
            name: "step-issuer",
        },
    },
});

const kubeStateMetrics = new k8s.apiextensions.CustomResource("kube-state-metrics-inbound-tls", {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
        name: "kube-state-metrics-inbound-tls",
        namespace: NS,
    },
    spec: {
        secretName: "kube-state-metrics-inbound-tls",
        commonName: "kube-prometheus-stack-kube-state-metrics",
        dnsNames: [
            `kube-prometheus-stack-kube-state-metrics.${NS}.svc.cluster.local`,
            "kube-prometheus-stack-kube-state-metrics"
        ],
        issuerRef: {
            group: "certmanager.step.sm",
            kind: "StepClusterIssuer",
            name: "step-issuer",
        },
    },
});


// TODO check default insecureSkipVerify
new k8s.helm.v4.Chart(kubePrometheusStackRelaseName, {
    namespace: NS,
    version: KUBE_PROMETHEUS_STACK_VERSION,
    chart: "kube-prometheus-stack",
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    // Includes scraping for cAdvisor
    values: {
        crds: {
            enabled: false
        },
        alertmanager: {
            enabled: false
        },
        grafana: {
            enabled: false,
            // Tailored dashboards
            forceDeployDashboards: true
        },
        prometheus: {
            serviceMonitor: {
                metricRelabelings: [
                    addClusterLabel
                ],
                scheme: "https",
                tlsConfig: {
                    caFile: "/var/run/step/ca.crt",
                    serverName: `kube-prometheus-stack-prometheus.${NS}.svc.cluster.local`,
                    insecureSkipVerify: false
                }
            },
            prometheusSpec: { 
                retention: PROMETHEUS_RENTION,
                storageSpec: {
                    volumeClaimTemplate: {
                        spec: {
                            resources: {
                                requests: {
                                    storage: PROMETHEUS_REQUEST_STORAGE
                                }
                            }
                        }
                    }
                },
                web: { 
                    tlsConfig: { 
                        keySecret: { 
                            key: "tls.key", 
                            name: prometheusCert.metadata.name 
                        },
                        cert: { 
                            secret: { 
                                key: "tls.crt", 
                                name: prometheusCert.metadata.name 
                            } 
                        },
                        client_ca: {
                            secret: { 
                                key: "ca.crt", 
                                name: prometheusCert.metadata.name 
                            } 
                        },
                        clientAuthType: "VerifyClientCertIfGiven" // can be upgraded to RequireAndVerifyClientCert
                    }
                },
                volumes: [
                    {
                        name: prometheusCert.metadata.name,
                        secret: {
                            secretName: prometheusCert.metadata.name
                        }
                    }
                ],
                volumeMounts: [
                    {
                        name: prometheusCert.metadata.name,
                        mountPath: "/var/run/step"
                    }
                ]
            }
        },
        prometheusOperator: {
            // Readiness probes cannot send certificate
            // https://github.com/prometheus-community/helm-charts/blob/main/charts/kube-prometheus-stack/templates/prometheus-operator/deployment.yaml
            // extraArgs: [
            //     "--web.client-ca-file=/cert/ca.crt",
            // ],
            admissionWebhooks: {
                certManager: {
                    enabled: true,
                    admissionCert: {
                        duration: TLS_DURATION
                    },
                    issuerRef: {
                        group: "certmanager.step.sm",
                        kind: "StepClusterIssuer",
                        name: "step-issuer",
                    }
                }
            },
            metricRelabelings: [
                addClusterLabel
            ]
        },
        kubeProxy: {
            serviceMonitor: {
                metricRelabelings: [
                    addClusterLabel
                ]
            }
        },
        coreDns: {
            serviceMonitor: {
                metricRelabelings: [
                    addClusterLabel
                ]
            }
        },
        kubeApiServer: {
            serviceMonitor: {
                metricRelabelings: [
                    addClusterLabel
                ]
            }
        },
        kubelet: {
            serviceMonitor: {
                cAdvisorRelabelings: [
                    {
                        action: "replace",
                        sourceLabels: [
                            "__metrics_path__"
                        ],
                        targetLabel: "metrics_path"
                    },
                    addClusterLabel
                ],
                relabelings: [
                    {
                        action: "replace",
                        sourceLabels: [
                            "__metrics_path__"
                        ],
                        targetLabel: "metrics_path"
                    },
                    addClusterLabel
                ],
                // ? why cannot be probesMetricsRelabelings (same issue other places)
                probesRelabelings: [
                    {
                        action: "replace",
                        sourceLabels: [
                            "__metrics_path__"
                        ],
                        targetLabel: "metrics_path"
                    },
                    addClusterLabel
                ]
            }
        },
        "kube-state-metrics": {
            kubeRBACProxy: {
                enabled: true,
                extraArgs: [
                    "--tls-cert-file=/var/run/step/tls.crt",
                    "--tls-private-key-file=/var/run/step/tls.key",
                    "--client-ca-file=/var/run/step/ca.crt"
                ],
                volumeMounts: [
                    {
                        name: kubeStateMetrics.metadata.name,
                        mountPath: "/var/run/step"
                    }
                ]
            },
            prometheus: {
                monitor: {
                    enabled: true,
                    relabelings: [
                        addClusterLabel
                    ],
                    http: {
                        scheme: "https",
                        bearerTokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
                        tlsConfig: {
                            caFile: "/var/run/step/ca.crt",
                            serverName: `kube-prometheus-stack-kube-state-metrics.${NS}.svc.cluster.local`,
                            insecureSkipVerify: false
                        }
                    }
                }
            },
            //! Isolation risk... Badly configured readinessprobe... internal ip loopback requires network host!?
            //? Might do PR... https://github.com/prometheus-community/helm-charts/tree/kube-prometheus-stack-66.2.2/charts/kube-state-metrics
            hostNetwork: true,
            volumes: [
                {
                    name: kubeStateMetrics.metadata.name,
                    secret: {
                        secretName: kubeStateMetrics.metadata.name
                    }
                }
            ],
        },
        // https://github.com/dotdc/grafana-dashboards-kubernetes?tab=readme-ov-file#known-issues
        "prometheus-node-exporter": {
            kubeRBACProxy: {
                proxyEndpointsPort: 8887, //* Just because kube-state-metrics is a bad chart
                enabled: true,
                tls: {
                    enabled: true,
                    tlsClientAuth: true
                }
            },
            tlsSecret: {
                enabled: true,
                caItem: "ca.crt",
                certItem: "tls.crt",
                keyItem: "tls.key",
                secretName: nodeExporterCert.metadata.name,
            },
            prometheus: {
                monitor: {       
                    metricRelabelings: [
                        addClusterLabel
                    ],  
                    scheme: "https",
                    bearerTokenFile: "/var/run/secrets/kubernetes.io/serviceaccount/token",
                    tlsConfig: {
                        caFile: "/var/run/step/ca.crt",
                        serverName: `kube-prometheus-stack-prometheus-node-exporter.${NS}.svc.cluster.local`,
                        insecureSkipVerify: false
                    },
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

const webConfig = `
tls_server_config:
  cert_file: /var/run/autocert.step.sm/site.crt
  key_file: /var/run/autocert.step.sm/site.key
  client_ca_file: /var/run/autocert.step.sm/root.crt
  client_auth_type: VerifyClientCertIfGiven
`

const mountPath = "/var/run/webconfig";
const webConfigConfigmap = new k8s.core.v1.ConfigMap("webconfig", {
    metadata: {
        namespace: NS
    },
    data: {
        [WEBCONFIGFILE]: webConfig
    }
});

const mounts =  {
    extraVolumeMounts: [
        {
            name: webConfigConfigmap.metadata.name,
            mountPath: mountPath
        }
    ],
    extraVolumes: [
        {
            name: webConfigConfigmap.metadata.name,
            configMap: {
                name: webConfigConfigmap.metadata.name
            }
        }
    ],
}

const podAnnotationsExporters = {
    "autocert.step.sm/name": `loki-chunks-cache.${NS}.svc.cluster.local`,
    "autocert.step.sm/sans": `loki-chunks-cache.${NS}.svc.cluster.local,loki.${NS}.svc.cluster.local`
}

// https://grafana.com/docs/loki/latest/setup/install/helm/install-monolithic/
// https://github.com/grafana/loki/tree/main/production/helm/loki
new k8s.helm.v4.Chart("loki", {
    namespace: NS,
    version: LOKI_VERSION,
    chart: "loki",
    repositoryOpts: {
        repo: "https://grafana.github.io/helm-charts",
    },
    values: {
        deploymentMode: "SingleBinary",
        loki: {
            limits_config: {
                retention_period: LOKI_LOG_RENTION
            },
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
            },
            server: {
                http_tls_config: {
                    client_auth_type: "VerifyClientCertIfGiven",
                    client_ca_file:"/var/run/autocert.step.sm/root.crt",
                    cert_file: "/var/run/autocert.step.sm/site.crt",
                    key_file: "/var/run/autocert.step.sm/site.key"
                }
            },
            readinessProbe: {
                httpGet: {
                    path: "/ready",
                    port: "http-metrics",
                    scheme: "HTTPS",
                },
                initialDelaySeconds: 30,
                timeoutSeconds: 1
            },
            podAnnotations: {
                "autocert.step.sm/name": `loki.${NS}.svc.cluster.local`,
                "autocert.step.sm/sans": `loki.${NS}.svc.cluster.local,loki`
            },
        },
        singleBinary: {
            replicas: 1,
            persistence: {
                size: LOKI_REQUEST_STORAGE
            }
        },
        read: {
            replicas: 0
        },
        backend: {
            replicas: 0
        },
        write: {
            replicas: 0
        },
        monitoring: {
            dashboards: {
                enabled: true
            },
            serviceMonitor: {
                enabled: true,
                labels: {
                    release: kubePrometheusStackRelaseName
                },
                metricRelabelings: [
                    addClusterLabel
                ],
                scheme: "https",
                tlsConfig: {
                    caFile: "/var/run/step/ca.crt",
                    certFile: "/var/run/step/tls.crt",
                    keyFile: "/var/run/step/tls.key",
                    serverName: `loki.${NS}.svc.cluster.local`,
                    insecureSkipVerify: false
                }
            }
        },
        lokiCanary: {
            enabled: false
        },
        test: {
            enabled: false
        },
        gateway: {
            enabled: false
        },
        memcachedExporter: {
            extraArgs: {
                "web.config.file": `${mountPath}/${WEBCONFIGFILE}`
            }
        },
        resultsCache: {
            podAnnotations: podAnnotationsExporters,
            ...mounts
        },
        chunksCache: {
            podAnnotations: podAnnotationsExporters,
            ...mounts
        }
    },
});

/* -------------------------------- Promtail -------------------------------- */

// https://github.com/grafana/loki/issues/8965

const serverConfig =
`http_tls_config:
    cert_file: /var/run/autocert.step.sm/site.crt
    key_file: /var/run/autocert.step.sm/site.key
    client_ca_file: /var/run/autocert.step.sm/root.crt
    client_auth_type: VerifyClientCertIfGiven`

new k8s.helm.v3.Chart("promtail", {
    namespace: NS,
    version: PROMTAIL_VERSION,
    chart: "promtail",
    fetchOpts: {
        repo: "https://grafana.github.io/helm-charts",
    },
    values: {
        config: {
            clients: [{
                url: "https://loki:3100/loki/api/v1/push",        
                tls_config: {        
                    ca_file:"/var/run/autocert.step.sm/root.crt",
                    cert_file: "/var/run/autocert.step.sm/site.crt",
                    key_file: "/var/run/autocert.step.sm/site.key"
                }
            }],
            snippets: {
                extraServerConfigs: serverConfig
            }
        },
        podAnnotations: {
            "autocert.step.sm/name": `promtail-metrics.${NS}.svc.cluster.local`
        },
        readinessProbe: {
            httpGet: {
                scheme: "HTTPS",
            }
        },
        serviceMonitor: {
            enabled: true,
            labels: {
                release: kubePrometheusStackRelaseName
            },
            metricRelabelings: [
                addClusterLabel
            ],
            scheme: "https",
            tlsConfig: {
                caFile: "/var/run/step/ca.crt",
                serverName: `promtail-metrics.${NS}.svc.cluster.local`,
                insecureSkipVerify: false
            }
        }
    }
});
