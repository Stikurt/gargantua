Synthetic local HTTPS fault-test certificate and private key only.
This public fixture key is never a production identity or secret.
SANs: one.fixture.test, two.fixture.test, 2606:4700:4700::1111.
Tests explicitly trust this certificate in their injected loopback transport.
Production fetchSafe does not trust this certificate or allow private targets.
No DNS or certificate store is changed by these tests.
