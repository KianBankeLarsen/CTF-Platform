import { envSubst, serviceTemplate, Stack } from "@ctf/utilities";
import * as docker from "@pulumi/docker";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from 'path';

/* ------------------------------ prerequisite ------------------------------ */

const config = new pulumi.Config();

const appLabels = {
    ctfd: { app: "ctfd" },
    ctfd_db: { app: "ctfd-db" },
    bastion: { app: "bastion" },
    sshl: { app: "sshl-multiplexer" },
    registry: { app: "image-registry" },
    welcome: { app: "welcome" }
}

const stack = pulumi.getStack();
const org = pulumi.getOrganization();
const stackReference = new pulumi.StackReference(`${org}/infrastructure/${stack}`);

/* --------------------------------- config --------------------------------- */

const HENRIK_BACKEND_CHART = "./challenges/backend/deployment/helm"
const NS = stack;
const CTFD_PORT = 8000
const CTFD_PROXY_PORT = 3080;
const REGISTRY_PORT = 5000;
const WELCOME_IMAGE_PORT = 3080;
const REGISTRY_EXPOSED_PORT = parseInt(config.require("REGISTRY_EXPOSED_PORT"));
const CTFD_HOST = config.require("CTFD_HOST");
const IMAGE_REGISTRY_HOST = config.require("IMAGE_REGISTRY_HOST");
const IMAGE_REGISTRY_SERVER = `${IMAGE_REGISTRY_HOST}:${REGISTRY_EXPOSED_PORT}`;
const CTFD_OIDC_PLUGIN_PATH = config.require("CTFD_OIDC_PLUGIN_PATH");
const CTFD_HTTP_RELATIVE_PATH = config.require("CTFD_HTTP_RELATIVE_PATH");
const SSLH_NODEPORT = config.require("SSLH_NODEPORT");
const CTFD_DATABASE_NAME = config.require("CTFD_DATABASE_NAME");
const POSTGRESQL_VERSION = config.require("POSTGRESQL_VERSION");
const STEP_CA_HOST = config.require("STEP_CA_HOST");
const HENRIK_BACKEND_HOST = config.require("HENRIK_BACKEND_HOST");
const WELCOME_HOST = config.require("WELCOME_HOST");
const BASTION_HOST = config.require("BASTION_HOST");
const REGISTRY_TAG = config.require("REGISTRY_TAG");
const HTTPD_TAG = config.require("HTTPD_TAG");
const SSLH_TAG = config.require("SSLH_TAG");
const SERVER_NAME = config.require("SERVER_NAME");
const ACME_DIRECTORY = config.require("ACME_DIRECTORY");
const ACME_EMAIL = config.require("ACME_EMAIL");
// Remove trailing slash if it exists, but keep the root '/' intact
const cleanedCtfdPath = (CTFD_HTTP_RELATIVE_PATH !== '/' && CTFD_HTTP_RELATIVE_PATH.endsWith('/'))
    ? CTFD_HTTP_RELATIVE_PATH.slice(0, -1)
    : CTFD_HTTP_RELATIVE_PATH;

/* --------------------------------- secret --------------------------------- */

const CTFD_CLIENT_SECRET =
    stackReference.requireOutput("ctfdRealmSecret") as pulumi.Output<string>;
const DOCKER_USERNAME =
    stackReference.requireOutput("dockerUsername") as pulumi.Output<string>;
const DOCKER_PASSWORD =
    stackReference.requireOutput("dockerPassword") as pulumi.Output<string>;
const CTFD_JWT_SECRET =
    stackReference.requireOutput("jwtCtfd") as pulumi.Output<string>;
const CTFD_API_TOKEN =
    stackReference.requireOutput("ctfdApiToken") as pulumi.Output<string>;
const POSTGRES_CTFD_ADMIN_PASSWORD =
    stackReference.requireOutput("postgresCtfdAdminPassword") as pulumi.Output<string>;
const BACKEND_API_POSTGRESQL =
    stackReference.requireOutput("backendApiPostgresql") as pulumi.Output<string>;

/* -------------------------------- Regsitry -------------------------------- */

pulumi.all([DOCKER_USERNAME, DOCKER_PASSWORD, POSTGRES_CTFD_ADMIN_PASSWORD, CTFD_DATABASE_NAME]).apply(([dockerUsername, dockerPassword, postgresCtfdAdminPassword, ctfdDbName]) => {
    const caConfig = k8s.core.v1.ConfigMap.get("step-certificates-config", `${NS}/step-step-certificates-config`);
    const caCert = k8s.core.v1.ConfigMap.get("step-certificates-certs", `${NS}/step-step-certificates-certs`);

    const imageRegistryDeployment = new k8s.apps.v1.Deployment("docker-registry-deployment", {
        metadata: { namespace: NS },
        spec: {
            selector: { matchLabels: appLabels.registry },
            template: {
                metadata: {
                    labels: appLabels.registry,
                    name: "image-registry",
                    annotations: {
                        "autocert.step.sm/name": `image-registry.${NS}.svc.cluster.local`
                    }
                },
                spec: {
                    initContainers: [{
                        name: "init-htpasswd",
                        image: `httpd:${HTTPD_TAG}`,
                        command: ["sh", "-c"],
                        args: [`htpasswd -Bbn ${dockerUsername} ${dockerPassword} > /auth/htpasswd`],
                        volumeMounts: [
                            { name: "auth-volume", mountPath: "/auth" },
                        ],
                    }],
                    containers: [{
                        name: "docker-registry",
                        image: `registry:${REGISTRY_TAG}`,
                        env: [
                            { name: "REGISTRY_AUTH", value: "htpasswd" },
                            { name: "REGISTRY_AUTH_HTPASSWD_REALM", value: "Registry Realm" },
                            { name: "REGISTRY_AUTH_HTPASSWD_PATH", value: "/auth/htpasswd" },
                            { name: "REGISTRY_HTTP_TLS_CERTIFICATE", value: "/var/run/autocert.step.sm/site.crt" },
                            { name: "REGISTRY_HTTP_TLS_KEY", value: "/var/run/autocert.step.sm/site.key" },
                        ],
                        volumeMounts: [
                            { name: "auth-volume", mountPath: "/auth" },
                        ],
                        readinessProbe: {
                            httpGet: {
                                path: "/",
                                port: REGISTRY_PORT,
                                scheme: "HTTPS"
                            },
                            initialDelaySeconds: 5,
                            periodSeconds: 10
                        }
                    }],
                    volumes: [
                        { name: "auth-volume", emptyDir: {} },
                    ],
                },
            },
        },
    });

    const imagePullSecret = new k8s.core.v1.Secret("image-pull-secret", {
        metadata: {
            namespace: NS
        },
        type: "kubernetes.io/dockerconfigjson",
        data: {
            ".dockerconfigjson": pulumi.secret(Buffer.from(JSON.stringify({
                auths: {
                    [`${IMAGE_REGISTRY_SERVER}`]: {
                        username: dockerUsername,
                        password: dockerPassword,
                        auth: Buffer.from(`${dockerUsername}:${dockerPassword}`).toString('base64'),
                    },
                },
            })).toString('base64')),
        },
    });

    const dockerImageRegistryService = new k8s.core.v1.Service(`image-registry-service`, {
        metadata: { namespace: NS, name: "cluster-registry" },
        spec: {
            selector: appLabels.registry,
            type: stack === Stack.DEV ? "ClusterIP" : "NodePort",
            ports: [{
                port: REGISTRY_EXPOSED_PORT,
                targetPort: REGISTRY_PORT,
                nodePort: stack === Stack.DEV ? undefined : REGISTRY_EXPOSED_PORT
            }],
        }
    });


    let registryDependencyList = []
    let registryIngress: k8s.networking.v1.Ingress;

    if (stack === Stack.DEV) {
        registryIngress = new k8s.networking.v1.Ingress("registry-ingress", {
            metadata: {
                namespace: NS,
                annotations: {
                    "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
                    "nginx.ingress.kubernetes.io/proxy-body-size": "0", // disable package size
                    "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
                    "cert-manager.io/issuer": "step-issuer",
                    "cert-manager.io/issuer-kind": "StepIssuer",
                    "cert-manager.io/issuer-group": "certmanager.step.sm"
                },
            },
            spec: {
                ingressClassName: "nginx",
                rules: [{
                    host: IMAGE_REGISTRY_HOST,
                    http: {
                        paths: [{
                            path: "/",
                            pathType: "Prefix",
                            backend: {
                                service: {
                                    name: dockerImageRegistryService.metadata.name,
                                    port: {
                                        number: REGISTRY_EXPOSED_PORT,
                                    },
                                },
                            },
                        }],
                    },
                }],
                tls: [{
                    hosts: [IMAGE_REGISTRY_HOST],
                    secretName: "image-registry-tls"
                }]
            },
        });
        registryDependencyList = [imageRegistryDeployment, registryIngress, dockerImageRegistryService]
    } else {
        registryDependencyList = [imageRegistryDeployment, dockerImageRegistryService]
    }

    /* ---------------------------------- CTFD ---------------------------------- */

    const ctfdPostgresqlSecret = new k8s.core.v1.Secret("cftd-postgresql-secret", {
        metadata: {
            namespace: NS,
        },
        stringData: {
            "postgres-password": POSTGRES_CTFD_ADMIN_PASSWORD,
        }
    });

    const postgresCtfdCert = new k8s.apiextensions.CustomResource("postgres-ctfd-inbound-tls", {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: {
            name: "postgres-ctfd-inbound-tls",
            namespace: NS,
        },
        spec: {
            secretName: "postgres-ctfd-inbound-tls",
            commonName: "postgresql-ctfd",
            dnsNames: [
                "postgresql-ctfd",
                `postgresql-ctfd.${NS}.svc.cluster.local`,
            ],
            duration: "24h",
            renewBefore: "8h",
            issuerRef: {
                group: "certmanager.step.sm",
                kind: "StepIssuer",
                name: "step-issuer",
            },
        },
    });

    new k8s.helm.v4.Chart("postgresql-ctfd", {
        namespace: NS,
        version: POSTGRESQL_VERSION,
        chart: "oci://registry-1.docker.io/bitnamicharts/postgresql",
        values: {
            tls: {
                enabled: true,
                autoGenerated: false,
                certificatesSecret: postgresCtfdCert.metadata.name,
                certFilename: "tls.crt",
                certKeyFilename: "tls.key",
                // certCAFilename: "ca.crt" // disable mTLS... "could not accept SSL connection: EOF detected"
            },
            auth: {
                database: ctfdDbName,
                existingSecret: ctfdPostgresqlSecret.metadata.name,
                secretKeys: {
                    adminPasswordKey: "postgres-password",
                }
            }
        }
    });

    const nginxImageHttps = new docker.Image("nginx-https-image", {
        build: {
            context: "./nginx",
            dockerfile: "./nginx/Dockerfile",
            platform: "linux/amd64",
            args: { NGINX_CONF: "nginx-https.conf" },
            builderVersion: docker.BuilderVersion.BuilderV1,
        },
        registry: {
            server: IMAGE_REGISTRY_SERVER,
            username: dockerUsername,
            password: dockerPassword
        },
        imageName: `${IMAGE_REGISTRY_SERVER}/nginx:https-latest`,
        skipPush: false,
    }, { dependsOn: registryDependencyList });

    nginxImageHttps.repoDigest.apply(digest => console.log("nginx-https image digest:", digest))

    // Challenges plugin baked into image

    const ctfdImage = new docker.Image("ctfd-image", {
        build: {
            context: ".",
            dockerfile: "./ctfd/Dockerfile",
            platform: "linux/amd64",
            builderVersion: docker.BuilderVersion.BuilderV1,
        },
        registry: {
            server: IMAGE_REGISTRY_SERVER,
            username: dockerUsername,
            password: dockerPassword
        },
        imageName: `${IMAGE_REGISTRY_SERVER}/ctfd:latest`,
        skipPush: false,
    }, { dependsOn: registryDependencyList });

    ctfdImage.repoDigest.apply(digest => console.log("CTFd image digest:", digest))

    // OIDC

    const ctfdOidcFolder = path.resolve(CTFD_OIDC_PLUGIN_PATH);
    const configFile = "config.json"

    const configMapOidc: { [key: string]: string } = {};
    const pluginFile = path.join(ctfdOidcFolder, configFile);
    configMapOidc[configFile] = fs.readFileSync(pluginFile, { encoding: "utf-8" });

    CTFD_CLIENT_SECRET.apply(secret => {
        configMapOidc[configFile] = envSubst(configMapOidc[configFile], "OIDC_CLIENT_SECRET", secret)

        const oidcPlugin = new k8s.core.v1.ConfigMap("oidc-plugin", {
            metadata: {
                namespace: NS
            },
            data: configMapOidc,
        });

        // TODO verify OIDC TLS
        new k8s.apps.v1.Deployment("ctfd-deployment", {
            metadata: { namespace: NS },
            spec: {
                selector: { matchLabels: appLabels.ctfd },
                template: {
                    metadata: {
                        labels: appLabels.ctfd,
                        annotations: {
                            "autocert.step.sm/name": `ctfd.${NS}.svc.cluster.local`,
                            "autocert.step.sm/sans": `ctfd.${NS}.svc.cluster.local,ctfd-service,ctfd`
                        }
                    },
                    spec: {
                        containers: [
                            {
                                name: "ctfd",
                                image: ctfdImage.repoDigest,
                                volumeMounts: [{
                                    name: "plugin-config",
                                    mountPath: "/opt/CTFd/CTFd/plugins/ctfd_oidc/config.json",
                                    subPath: "config.json"
                                }],
                                env: [
                                    { name: "APPLICATION_ROOT", value: cleanedCtfdPath },
                                    { name: "REVERSE_PROXY", value: "true" },
                                    { name: "JWTSECRET", value: CTFD_JWT_SECRET },
                                    { name: "BACKENDURL", value: `http://deployer.${NS}.svc.cluster.local:8080` },
                                    { name: "API_TOKEN", value: CTFD_API_TOKEN },
                                    {
                                        name: "DATABASE_URL",
                                        value: `postgresql+psycopg2://postgres:${postgresCtfdAdminPassword}@postgresql-ctfd:5432/${ctfdDbName}`
                                            + `?sslmode=verify-full&sslrootcert=/var/run/autocert.step.sm/root.crt`
                                    }
                                ]
                            },
                            {
                                name: "nginx-tls-proxy",
                                image: nginxImageHttps.repoDigest,
                                ports: [{ containerPort: CTFD_PROXY_PORT }],
                                env: [{ name: "PROXY_PASS_URL", value: `http://localhost:${CTFD_PORT}` }]
                            }
                        ],
                        imagePullSecrets: [{ name: imagePullSecret.metadata.name }],
                        volumes: [{
                            name: "plugin-config",
                            configMap: {
                                name: oidcPlugin.metadata.name,
                            }
                        }]
                    }
                }
            }
        }, { dependsOn: [ctfdImage, nginxImageHttps] });
    });

    const ctfdService = serviceTemplate(
        "ctfd",
        NS,
        [{ port: 443, targetPort: CTFD_PROXY_PORT }],
        appLabels.ctfd
    )

    new k8s.networking.v1.Ingress("ctfd-ingress", {
        metadata: {
            namespace: NS,
            annotations: {
                "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
                "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
                "cert-manager.io/issuer": "step-issuer",
                "cert-manager.io/issuer-kind": "StepIssuer",
                "cert-manager.io/issuer-group": "certmanager.step.sm",
            },
        },
        spec: {
            ingressClassName: "nginx",
            tls: [{
                hosts: [CTFD_HOST],
                secretName: "ctfd-tls",
            }],
            rules: [{
                host: CTFD_HOST,
                http: {
                    paths: [{
                        path: cleanedCtfdPath,
                        pathType: "Prefix",
                        backend: {
                            service: {
                                name: ctfdService.metadata.name,
                                port: {
                                    number: 443,
                                },
                            },
                        },
                    }],
                },
            }],
        },
    });

    // /* ------------------------------- SSH Bastion ------------------------------ */

    const bastionImage = new docker.Image("bastion-image", {
        build: {
            context: "./bastion",
            dockerfile: "./bastion/Dockerfile",
            platform: "linux/amd64",
            builderVersion: docker.BuilderVersion.BuilderV1,
        },
        registry: {
            server: IMAGE_REGISTRY_SERVER,
            username: dockerUsername,
            password: dockerPassword
        },
        imageName: `${IMAGE_REGISTRY_SERVER}/bastion:latest`,
        skipPush: false,
    }, { dependsOn: registryDependencyList });

    bastionImage.repoDigest.apply(digest => console.log("Bastion image digest:", digest))

    const fingerprint = caConfig.data.apply(data => JSON.parse(data['defaults.json']).fingerprint);

    const bastion = new k8s.apps.v1.Deployment("bastion-deployment", {
        metadata: { namespace: NS },
        spec: {
            selector: { matchLabels: appLabels.bastion },
            template: {
                metadata: { labels: appLabels.bastion },
                spec: {
                    containers: [
                        {
                            name: "ssh-bastion",
                            image: bastionImage.repoDigest,
                            ports: [{ containerPort: 22 }],
                            env: [
                                {
                                    name: "KEY_ID",
                                    value: "myhost"
                                },
                                {
                                    name: "CA_FINGERPRINT",
                                    value: fingerprint
                                }
                            ],
                            volumeMounts: [
                                {
                                    name: "ca-user-key",
                                    mountPath: "/etc/ssh/ca_user_key.pub",
                                    subPath: "ca_user_key.pub"
                                },
                                {
                                    name: "provisioner-password",
                                    mountPath: "/etc/ssh/provisioner_password",
                                    subPath: "provisioner_password"
                                }
                            ]
                        },
                    ],
                    imagePullSecrets: [{ name: imagePullSecret.metadata.name }],
                    volumes: [
                        {
                            name: "ca-user-key",
                            configMap: {
                                name: "step-step-certificates-certs",
                                items: [{
                                    key: "ssh_user_ca_key.pub",
                                    path: "ca_user_key.pub"
                                }]
                            }
                        },
                        {
                            name: "provisioner-password",
                            secret: {
                                secretName: "step-step-certificates-provisioner-password",
                                items: [{
                                    key: "password",
                                    path: "provisioner_password"
                                }]
                            }
                        }
                    ]
                }
            }
        }
    }, { dependsOn: bastionImage });

    new k8s.core.v1.Service("bastion-service", {
        metadata: { namespace: NS, name: "bastion" },
        spec: {
            selector: appLabels.bastion,
            ports: [{ port: 22 }]
        }
    });

    /* ----------------------------- Henrik Backend ----------------------------- */

    const backendAPI = new docker.Image("backend-image", {
        build: {
            context: "./challenges/backend",
            dockerfile: "./challenges/backend/Dockerfile",
            platform: "linux/amd64",
            builderVersion: docker.BuilderVersion.BuilderV1,
        },
        registry: {
            server: IMAGE_REGISTRY_SERVER,
            username: dockerUsername,
            password: dockerPassword
        },
        imageName: `${IMAGE_REGISTRY_SERVER}/backend:latest`,
        skipPush: false,
    }, { dependsOn: registryDependencyList });

    backendAPI.repoDigest.apply(digest => console.log("Backend API image digest:", digest))

    const postgresqlBackendAPI = new k8s.core.v1.Secret("backend-api-postgresql-secret", {
        metadata: {
            namespace: NS,
        },
        stringData: {
            "postgres-password": BACKEND_API_POSTGRESQL
        }
    });

    new k8s.helm.v4.Chart("deployer", {
        namespace: NS,
        chart: HENRIK_BACKEND_CHART,
        dependencyUpdate: true,
        values: {
            ingress: {
                host: HENRIK_BACKEND_HOST
            },
            podAnnotations: {
                "autocert.step.sm/name": `deployer.${NS}.svc.cluster.local`
            },
            image: {
                repository: `${IMAGE_REGISTRY_SERVER}/backend`,
                pullPolicy: "Always",
                tag: "latest"
            },
            imagePullSecrets: [{ name: imagePullSecret.metadata.name }],
            postgresql: {
                auth: {
                    existingSecret: postgresqlBackendAPI.metadata.name,
                    secretKeys: {
                        adminPasswordKey: "postgres-password",
                    }
                }
            },
            env: {
                CTFDAPITOKEN: CTFD_API_TOKEN,
                CTFDURL: `https://ctfd/ctfd`,
                BACKENDURL: `http://deployer.${NS}.svc.cluster.local:8080`,
                JWKSURL: "https://keycloak/keycloak/realms/ctf/protocol/openid-connect/certs",
                ROOTCERT: "/var/run/autocert.step.sm/root.crt",
                CHALLENGEDOMAIN: "." + HENRIK_BACKEND_HOST
            }
        }
    }, { dependsOn: backendAPI });

    /* ------------------------------- Multiplexer ------------------------------ */

    const CERTBOT_OPTIONS = stack === Stack.DEV ? "--no-verify-ssl" : ""

    const nginxImageHttp = new docker.Image("nginx-http-image", {
        build: {
            context: "./nginx",
            dockerfile: "./nginx/Dockerfile",
            platform: "linux/amd64",
            args: {
                NGINX_CONF: "nginx-certbot.conf",
                ENABLE_CERTBOT: "true",
                CERTBOT_OPTIONS: CERTBOT_OPTIONS
            },
            builderVersion: docker.BuilderVersion.BuilderV1,
        },
        registry: {
            server: IMAGE_REGISTRY_SERVER,
            username: dockerUsername,
            password: dockerPassword
        },
        imageName: `${IMAGE_REGISTRY_SERVER}/nginx:http-latest`,
        skipPush: false,
    }, { dependsOn: registryDependencyList });

    nginxImageHttp.repoDigest.apply(digest => console.log("nginx-http image digest:", digest))

    new k8s.apps.v1.Deployment("sslh-deployment", {
        metadata: { namespace: stack },
        spec: {
            selector: { matchLabels: appLabels.sshl },
            template: {
                metadata: { labels: appLabels.sshl },
                spec: {
                    containers: [
                        {
                            name: "sslh",
                            image: `ghcr.io/yrutschle/sslh:${SSLH_TAG}`,
                            args: [
                                "--foreground",
                                "--listen=0.0.0.0:3443",
                                "--tls=localhost:3080",
                                "--http=localhost:80", // use IPv6 // upgrade connection to https
                                "--ssh=bastion:22"
                            ],
                            ports: [{ containerPort: 3443 }]
                        },
                        {
                            name: "sslh-proxy",
                            image: nginxImageHttp.repoDigest,
                            env: [
                                {
                                    name: "PROXY_PASS_URL",
                                    value: "ingress-nginx-controller.ingress-nginx"
                                },
                                {
                                    name: "STEP_CA_HOST",
                                    value: STEP_CA_HOST
                                },
                                {
                                    name: "SERVER_NAME",
                                    value: SERVER_NAME
                                },
                                {
                                    name: "ACME_DIRECTORY",
                                    value: ACME_DIRECTORY
                                },
                                {
                                    name: "ACME_EMAIL",
                                    value: ACME_EMAIL
                                },
                                {
                                    name: "CERTBOT_OPTIONS",
                                    value: CERTBOT_OPTIONS
                                },
                            ],
                            ports: [{ containerPort: 443 }, { containerPort: 80 }]
                        }
                    ],
                    imagePullSecrets: [{ name: imagePullSecret.metadata.name }]
                }
            }
        }
    }, { dependsOn: [bastion, nginxImageHttp] });

    if (stack == Stack.DEV) {
        new k8s.core.v1.Service("acme-proxy", {
            metadata: { namespace: stack, name: SERVER_NAME },
            spec: {
                selector: appLabels.sshl,
                ports: [
                    {
                        name: "http",
                        port: 80,
                        targetPort: 80
                    }
                ]
            }
        });
    }

    new k8s.core.v1.Service("sslh-service", {
        metadata: { namespace: stack, name: "sslh-service" },
        spec: {
            selector: appLabels.sshl,
            type: "NodePort",
            ports: [
                {
                    port: 443,
                    targetPort: 3443,
                    nodePort: parseInt(SSLH_NODEPORT)
                },
            ]
        }
    });

    /* --------------------------------- Welcome -------------------------------- */

    const welcomeImage = new docker.Image("welcome-image", {
        build: {
            context: "./welcome",
            dockerfile: "./welcome/Dockerfile",
            platform: "linux/amd64",
            builderVersion: docker.BuilderVersion.BuilderV1,
        },
        registry: {
            server: IMAGE_REGISTRY_SERVER,
            username: dockerUsername,
            password: dockerPassword
        },
        imageName: `${IMAGE_REGISTRY_SERVER}/welcome:latest`,
        skipPush: false,
    }, { dependsOn: registryDependencyList });

    nginxImageHttp.repoDigest.apply(digest => console.log("welcome image digest:", digest))

    const SSH_PUB_CERT = caCert.data.apply(data => data['ssh_host_ca_key.pub']);

    new k8s.apps.v1.Deployment("welcome-deployment", {
        metadata: { namespace: stack },
        spec: {
            selector: { matchLabels: appLabels.welcome },
            template: {
                metadata: {
                    labels: appLabels.welcome,
                    annotations: {
                        "autocert.step.sm/name": `welcome.${NS}.svc.cluster.local`
                    }
                },
                spec: {
                    containers: [
                        {
                            name: "welcome",
                            image: welcomeImage.repoDigest,
                            env: [
                                {
                                    name: "STEP_CA_HOST",
                                    value: STEP_CA_HOST
                                },
                                {
                                    name: "CA_FINGERPRINT",
                                    value: fingerprint
                                },
                                {
                                    name: "BASTION_HOST",
                                    value: BASTION_HOST
                                },
                                {
                                    name: "SSH_PUB_CERT",
                                    value: SSH_PUB_CERT
                                }
                            ]
                        },
                    ],
                    imagePullSecrets: [{ name: imagePullSecret.metadata.name }]
                }
            }
        }
    }, { dependsOn: [welcomeImage] });

    const welcomeService = new k8s.core.v1.Service("welcome-service", {
        metadata: { namespace: stack },
        spec: {
            selector: appLabels.welcome,
            ports: [
                {
                    port: WELCOME_IMAGE_PORT
                }
            ]
        }
    });

    new k8s.networking.v1.Ingress("welcome-ingress", {
        metadata: {
            namespace: NS,
            annotations: {
                "nginx.ingress.kubernetes.io/backend-protocol": "HTTPS",
                "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
                "cert-manager.io/issuer": "step-issuer",
                "cert-manager.io/issuer-kind": "StepIssuer",
                "cert-manager.io/issuer-group": "certmanager.step.sm"
            },
        },
        spec: {
            ingressClassName: "nginx",
            rules: [{
                host: WELCOME_HOST,
                http: {
                    paths: [{
                        path: "/",
                        pathType: "Prefix",
                        backend: {
                            service: {
                                name: welcomeService.metadata.name,
                                port: {
                                    number: WELCOME_IMAGE_PORT,
                                },
                            },
                        },
                    }],
                },
            }],
            tls: [{
                hosts: [WELCOME_HOST],
                secretName: "welcome-registry-tls"
            }]
        },
    });
});