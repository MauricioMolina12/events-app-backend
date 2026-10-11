# Propuesta comercial — Sitio de eventos y panel de registro (Barby Toys & Cupidos)

> **Precio fijo de COP $ 650.000 por todo el proyecto.** Sin cobro por horas ni costos
> ocultos. Este documento explica en lenguaje sencillo **que recibe, cuando lo recibe y como
> se paga**. El detalle tecnico que respalda cada punto esta en el anexo interno
> [`docs/frontend/angular-pwa-prompt.md`](../frontend/angular-pwa-prompt.md), que no necesita
> revisar.

**El problema que resolvemos.** Hoy las inscripciones se atienden a mano y el dia del evento
la mesa de registro se vuelve el cuello de botella. Con este proyecto:

- **Sus clientes se inscriben solos** desde el celular: eligen evento y sede, registran
  acompanantes y reciben un comprobante con su numero de inscripcion.
- **El dia del evento se atiende mas rapido:** el personal busca a la persona por nombre,
  documento o correo y resuelve en segundos, sin planillas ni filas.
- **Su equipo administra solo:** crea eventos, sedes, cupos y usuarios sin depender del
  desarrollador para cada cambio.
- **Se ve bien, carga rapido y se instala en el celular**, y sirve incluso con mala conexion.

## 1. Resumen de la propuesta

| Campo | Valor |
| --- | --- |
| Cliente | Barby Toys & Cupidos |
| Proyecto | Sitio publico de eventos + panel de registro y administracion |
| Modalidad | **Precio fijo, todo incluido.** Sin cobro por horas |
| Valor del proyecto | **COP $ 650.000** (pago unico por el alcance completo, escenario 3) |
| Forma de pago | Por avances entregados y aceptados (ver §7) |
| Plazo estimado | 14 semanas calendario (≈ 3,5 meses) contadas desde el anticipo |
| Inicio estimado | [fecha] |
| Proveedor | [razon social / nombre] |
| NIT / CC | [completar] |
| Contacto | [nombre] · [email] · [telefono] |
| Fecha de emision | [dd/mm/aaaa] |
| Validez de la oferta | 30 dias calendario |
| Moneda | COP (peso colombiano), antes de impuestos |

---

## 2. Precio fijo, sin sorpresas

- **COP $ 650.000 por todo el proyecto.** No se cobra por hora, por dia ni por tiempo
  dedicado: si el trabajo toma mas esfuerzo del previsto, el precio no cambia.
- Los valores de §3 y §4 son **la forma de repartir ese unico precio** entre los componentes
  del proyecto. Sirven para pagar por avances y para saber cuanto cuesta contratar solo una
  parte (§6); **no** son una tarifa por hora.
- **No generan costo adicional:** las dudas y aclaraciones durante el proyecto, una ronda de
  ajustes menores despues de cada entrega y las 2 semanas de acompanamiento del cierre.
- **Si mas adelante quiere algo fuera de lo pactado**, se cotiza aparte como precio fijo y
  se ejecuta solo cuando usted lo apruebe por escrito. Nunca se factura "tiempo suelto".
- El precio esta **antes de impuestos y retenciones** (ver §8).

---

## 3. Que recibe — resumen y valores

La propuesta economica se maneja con **5 grupos**. Cada grupo reune varios componentes de
trabajo para que sea facil decidir que contratar, sin perderse en el detalle.

| # | Grupo de trabajo | Que incluye | Para que le sirve | Valor (COP) |
| --- | --- | --- | --- | ---: |
| G1 | Planeacion, base y estilo del sitio | D0, D1 y D2 | Acordamos el plan y dejamos lista la estructura y la imagen visual del sitio | 136.000 |
| G2 | Sitio publico e inscripciones en linea | D3, D4 y D5 | Sus clientes consultan eventos y se inscriben solos desde el celular, y el sitio se instala como aplicacion | 158.000 |
| G3 | Panel de registro y administracion | D6, D7 y D8 | El dia del evento se atiende sin filas ni planillas y su equipo gestiona eventos, sedes y cupos por su cuenta | 216.000 |
| G4 | Control de calidad con evidencia | D9 | El sistema completo se prueba antes de publicar y usted recibe el informe de resultados | 65.000 |
| G5 | Manuales, capacitacion y publicacion | D10 y D11 | Su equipo capacitado y el sitio en linea en su dominio, monitoreado y con 2 semanas de acompanamiento | 75.000 |
| | **TOTAL** | 12 componentes (D0 a D11) | **Precio fijo del proyecto** | **650.000** |

Los 5 grupos reunen los 12 componentes de trabajo (D0 a D11) que se detallan en §4; esa lista
larga sirve para conversar el alcance, pero la decision economica se toma sobre estos 5 grupos.
Los valores suman exactamente el precio de la propuesta y son la base de los escenarios de §6.
La dedicacion estimada de cada componente esta en el **Anexo A** (referencia interna de
planeacion, no es un cobro por horas). Equivalencia de referencia: ≈ USD 155 a una TRM de COP
4.200/USD; el precio pactado es en COP.

---

## 4. Detalle de lo que recibe

Los 12 componentes se agrupan en los 5 grupos de §3: **G1** = D0, D1 y D2 · **G2** = D3, D4 y
D5 · **G3** = D6, D7 y D8 · **G4** = D9 · **G5** = D10 y D11.

### D0 — Planeacion del proyecto · COP $ 19.000

**Que es.** Antes de construir, cerramos las decisiones que definen todo el trabajo.

**Incluye:** inventario de pantallas y recorridos del usuario; definicion del estilo visual y
de la tecnologia con la que se construye; decision de donde se publica el sitio y como
convive con el sistema actual; propuesta de marca provisional con criterios de color y
tipografia; calendario de entregas y criterios de aceptacion de cada componente.

**Se da por recibido cuando:** usted aprueba por escrito el plan y las decisiones.

---

### D1 — Base del sitio · COP $ 70.000

**Que es.** La estructura sobre la que se montan todas las pantallas: es lo que hace que el
sitio sea rapido, seguro y economico de ampliar despues.

**Incluye:** sitio base con tecnologia moderna y carga agil; organizacion interna que evita
que crecer se vuelva costoso; colores, tipografias y espaciados definidos como un estandar
reutilizable, con modo claro y oscuro; conexion segura con el sistema actual, con manejo de
errores y reintentos controlados; manejo de la sesion del usuario; revision automatica de
calidad (estilo de codigo, tipos, pruebas y compilacion) en cada cambio.

**Se da por recibido cuando:** el sitio navega y la revision automatica de calidad queda
aprobada de forma reproducible.

---

### D2 — Estilo e identidad visual del sitio · COP $ 47.000

**Que es.** El "kit de piezas" con el que se construyen todas las pantallas, para que el
sitio se vea profesional y consistente y no haya que rehacer diseno en cada vista.

**Incluye:** botones, campos de formulario con mensajes de error claros, listas
desplegables, casillas, etiquetas, tarjetas de evento, indicadores de estado, tablas con
orden y paginacion, ventanas de confirmacion, avisos flotantes, aviso de "sin conexion" y
los estados que toda pantalla debe saber mostrar (cargando, sin resultados, con error, sin
permisos); versiones para celular, tablet y computador; navegacion con teclado y foco visible
para personas que no usan mouse.

**Se da por recibido cuando:** cada pieza esta documentada, se ve bien en todos sus estados y
no presenta barreras de accesibilidad.

---

### D3 — Catalogo publico de eventos · COP $ 56.000

**Que es.** La cara publica: donde sus clientes descubren los eventos y eligen sede.

**Incluye:** listado de eventos publicados con buscador, filtros y paginacion (los filtros se
pueden compartir por enlace); ficha de cada evento con sus sedes, cupo disponible y fecha
limite de inscripcion; el boton de inscripcion se habilita solo cuando el sistema confirma
que la inscripcion esta abierta y, cuando esta cerrada, se explica el motivo; fechas
mostradas en la zona horaria del evento; mensajes claros de cargando, sin resultados y error;
contenido legible para los buscadores.

**Se da por recibido cuando:** una persona encuentra un evento y entiende si puede inscribirse
y hasta cuando, desde un celular pequeno.

---

### D4 — Inscripcion en linea · COP $ 65.000

**Que es.** El corazon del proyecto: el formulario con el que su cliente se inscribe solo y
recibe su comprobante. Es lo que reduce el trabajo manual y los errores de digitacion.

**Incluye:** formulario guiado con validacion en el momento (documento, correo, telefono) y
eleccion de sede; agregar y quitar acompanantes con los limites del cupo siempre visibles;
mensajes propios y comprensibles para cada situacion: **inscripcion duplicada**, **cupo
agotado del titular**, **cupo agotado de acompanantes**, **sede cerrada**, **evento no
inscribible** y **fuera de la fecha limite**, incluido el caso de **lista de espera**; los
errores de digitacion se senalan sobre el campo correspondiente; el boton de envio evita
inscripciones repetidas por doble clic; pantalla de comprobante con numero de inscripcion,
sede y fecha, con el espacio reservado para el codigo QR del control de acceso (opcion O1);
el comprobante se puede guardar en el celular y consultar despues en "mis inscripciones".

**Se da por recibido cuando:** el recorrido completo (elegir sede, inscribirse, ver el
comprobante) se realiza desde el celular y cada situacion muestra su propio mensaje.

---

### D5 — Aplicacion instalable (PWA) · COP $ 37.000

**Que es.** El sitio se comporta como una aplicacion: se instala en el celular, abre rapido y
permite consultar el catalogo aunque no haya conexion.

**Incluye:** icono en la pantalla de inicio y pantalla de arranque; consulta del catalogo sin
conexion con la ultima informacion vista; pagina propia de "sin conexion"; aviso claro de que
una inscripcion si necesita conexion (nunca se simula un exito que no ocurrio); aviso
discreto cuando hay una version nueva; boton de instalacion cuando el navegador lo permite.

**Se da por recibido cuando:** la aplicacion se instala, abre sin conexion mostrando el
catalogo ya consultado y no expone informacion privada desde la memoria del dispositivo.

---

### D6 — Acceso seguro al panel · COP $ 47.000

**Que es.** La entrada al area operativa y el marco de navegacion comun del panel.

**Incluye:** ingreso con usuario y clave; la sesion la controla el sistema interno con cookies
seguras, no el navegador; la sesion se conserva al recargar la pagina; permisos por rol
(administrador y operador), con pantalla propia cuando alguien no tiene permiso; cierre de
sesion automatico con regreso a la pantalla donde estaba; mensajes propios para credenciales
incorrectas, cuenta bloqueada, cuenta deshabilitada, sesion expirada y sesion cerrada desde
otro equipo; menu lateral adaptado a celular, con el nombre del usuario y el boton de salir.

**Se da por recibido cuando:** un operador entra, recarga sin perder la sesion y un usuario
sin permiso ve una pantalla clara en lugar de un error tecnico.

---

### D7 — Panel de registro del dia del evento · COP $ 75.000

**Que es.** La herramienta de la mesa de registro: atender a las personas sin filas ni
planillas.

**Incluye:** tablero con los eventos activos y la ocupacion por sede; busqueda de inscritos
por nombre, documento o correo, con filtros y resultados compartibles por enlace; las
inscripciones canceladas se pueden incluir o excluir y se distinguen por su motivo; registro
manual en el punto de atencion, con acompanantes y validacion de cupo con las mismas reglas
del sitio publico; cancelacion con motivo obligatorio, sin recargar la pagina y sin duplicar
cancelaciones; ficha del inscrito con titular, acompanantes, origen (publico o presencial),
estado y vigencia de la sede; vista para imprimir y espacio reservado para el codigo QR del
control de acceso; actualizacion automatica configurable y boton de refresco manual.

**Se da por recibido cuando:** un operador atiende 20 personas seguidas (buscar, inscribir,
cancelar, consultar) sin recargar la pagina y sin perder el hilo de la atencion.

---

### D8 — Administracion de eventos y cupos · COP $ 94.000

**Que es.** El panel con el que su equipo gestiona todo el catalogo sin depender de nosotros.

**Incluye:** eventos con buscador y filtro por estado, creacion y edicion (el identificador
publico del evento queda fijo para no romper enlaces ya compartidos) y solo los cambios de
estado validos: borrador, publicado, cerrado y archivado; sedes, activas o inactivas;
participaciones por evento y sede, cada una con su propia ventana de inscripcion, cupo de
titulares y cupo de acompanantes, mostrando siempre el dato de "inscripcion abierta" tal como
lo calcula el sistema interno (nunca adivinado por la pantalla); mensajes propios para cada
conflicto: sede cerrada, evento no inscribible y cupo por debajo de lo ya inscrito; usuarios
(solo administradores): crear, editar, activar o desactivar y rotar contrasena cerrando las
sesiones abiertas, sin posibilidad de dejar el sistema sin administradores; los borrados son
logicos (se conserva el historial) y cada confirmacion explica su consecuencia.

**Se da por recibido cuando:** cada situacion de conflicto tiene su mensaje y su accion en
pantalla, y no existe forma de dejar el sistema sin administradores.

---

### D9 — Control de calidad · COP $ 65.000

**Que es.** La verificacion del sistema completo antes de la entrega, con evidencia.

**Incluye:** pruebas automaticas de los recorridos criticos (catalogo, inscripcion y
comprobante; ingreso, mesa de registro y cancelacion; registro administrativo); revision
automatica de que la interfaz sigue comunicandose correctamente con el sistema interno ya
existente, para detectar desviaciones a tiempo; revision de accesibilidad sin barreras graves
y con contraste adecuado en modo claro y oscuro; respeto de la preferencia del usuario de
reducir animaciones; medicion de velocidad con metas acordadas; informe de resultados con
hallazgos y su estado.

**Se da por recibido cuando:** todas las pruebas pasan de forma automatica y se entrega el
informe con la cobertura por recorrido.

---

### D10 — Manuales y capacitacion · COP $ 28.000

**Que es.** La transferencia de conocimiento para que su equipo no dependa de nosotros.

**Incluye:** manual de la mesa de registro para personal no tecnico, con capturas de pantalla;
guia de operacion del panel (crear eventos, sedes y cupos); guia para publicar versiones
nuevas; documentacion tecnica del proyecto y de las decisiones tomadas; dos sesiones de
capacitacion grabadas (equipo operativo y equipo tecnico) con material y acta de asistencia.

**Se da por recibido cuando:** su equipo completa un registro de prueba siguiendo unicamente
los manuales entregados.

---

### D11 — Publicacion y acompanamiento · COP $ 47.000

**Que es.** La puesta en produccion verificada y el acompanamiento de las primeras semanas.

**Incluye:** preparacion de la version de produccion; publicacion del sitio en el destino
acordado; dominio propio con certificado de seguridad, cabeceras de proteccion y politicas de
cache; prueba del recorrido completo contra el sistema real; monitoreo basico de errores y
disponibilidad; plan de actualizacion de versiones sin interrumpir a los usuarios; **2 semanas
de acompanamiento** atendiendo incidencias dentro del alcance, con acta de cierre.

**Se da por recibido cuando:** el sitio publico y el panel operan en el dominio definitivo y
no quedan incidencias criticas abiertas.

---

## 5. Servicios opcionales (no incluidos en el precio)

Se cotizan aparte, como **precio fijo**, cuando usted los apruebe; solo entonces se facturan y
se ejecutan.

| # | Opcion | Que le aporta | Valor (COP) |
| --- | --- | --- | ---: |
| O1 | Turnos y control de acceso (QR) | Control de ingreso el dia del evento. Requiere desarrollar primero esa parte en el sistema interno | A convenir |
| O2 | Mejor posicionamiento en buscadores | Sus eventos aparecen mejor en Google, con enlaces compartibles y buena presentacion en redes | A convenir |
| O3 | Estadisticas de uso | Saber cuantos visitan cada evento, cuantos terminan la inscripcion y donde se pierden | A convenir |
| O4 | Version en ingles | El sitio completo en dos idiomas, con selector de idioma | A convenir |
| O5 | Pagos en linea | Cobro de inscripciones con pasarela de pago (depende del proveedor que elija y de sus comisiones) | A convenir |
| O6 | Mejoras y cambios posteriores | Bolsa de trabajo para seguir ajustando el sistema despues de la entrega, por jornadas acordadas | A convenir |
| O7 | Capacitacion adicional | Sesion de 2 horas para nuevos integrantes de su equipo, con material | A convenir |
| O8 | Certificado de accesibilidad | Revision formal de accesibilidad web con informe de cumplimiento | A convenir |
| O9 | Marca y piezas graficas | Logotipo, colores de marca e ilustraciones (lo realiza un disenador, no esta en el alcance tecnico) | Por definir |

---

## 6. Formas de contratacion

El proyecto se puede contratar completo o por etapas. Los escenarios 1, 2 y 3 son acumulativos
y avanzar por etapas **no tiene costo adicional**.

| Escenario | Que incluye | Inversion (COP) | Pensado para |
| --- | --- | ---: | --- |
| 1. Solo el sitio publico | G1 y G2 (componentes D0 a D5) | 294.000 | Validar primero las inscripciones en linea |
| 2. Sitio publico + panel de registro | G1 a G3 (componentes D0 a D8) | 510.000 | Ya hay eventos en curso que hay que operar |
| 3. Proyecto completo (**recomendado**) | G1 a G5 (componentes D0 a D11) | 650.000 | Tener la solucion terminada, probada y en produccion |
| 4. Solo modernizar el panel | G1, G3 y G4 (componentes D0 a D2 y D6 a D9) | 417.000 | Ya existe el sitio publico y falta la operacion interna |

- Cada escenario es **la suma exacta** de los grupos que incluye (por ejemplo, el escenario 1:
  136.000 + 158.000 = 294.000). Tome los grupos completos: G1 136.000, G2 158.000, G3 216.000,
  G4 65.000 y G5 75.000.
- Empezar por el escenario 1 y luego completar hasta el 3 cuesta exactamente la diferencia
  (356.000): no se paga dos veces por lo ya hecho.
- Los escenarios 1, 2 y 4 incluyen las pruebas propias de cada componente; el informe integral
  de calidad es exclusivo del escenario 3 (grupo G4, componente D9).

---

## 7. Forma de pago

Se paga por avances entregados y aceptados. Para el escenario 3:

| # | Momento del pago | Cuando | % | Valor (COP) |
| --- | --- | --- | ---: | ---: |
| P1 | Anticipo y arranque | Firma de la propuesta | 25% | 162.500 |
| P2 | Fundaciones del sitio | Aceptacion de G1 | 20% | 130.000 |
| P3 | Sitio publico e instalable | Aceptacion de G2 | 20% | 130.000 |
| P4 | Panel completo | Aceptacion de G3 | 25% | 162.500 |
| P5 | Calidad, manuales y publicacion | Aceptacion de G4 y G5 | 10% | 65.000 |
| | **Total** | | **100%** | **650.000** |

- El anticipo no es un pago extra: es la primera parte de los mismos 650.000.
- Cada porcentaje se calcula sobre el total del proyecto (650.000): la entrega aceptada de cada
  grupo es el disparador del pago, no el valor de ese grupo.
- Los demas escenarios siguen los mismos porcentajes sobre su valor (§6).
- Plazo de pago: **15 dias calendario** despues de radicar la factura con su acta.
- Cada entrega se revisa y se aprueba dentro de los **5 dias habiles** siguientes; si no hay
  respuesta en ese plazo, se entiende aceptada para no frenar el cronograma.
- El anticipo reserva el cupo en el calendario de trabajo: sin el, la fecha de inicio se
  reprograma.

---

## 8. Notas fiscales

- Todos los valores estan en **COP** y **antes de impuestos**.
- Si el proveedor es responsable de IVA, se adiciona el **19%** (sobre el escenario 3:
  **123.500**, para un total de 773.500).
- Las retenciones de ley (fuente, ICA y demas aplicables) se descuentan segun la normativa
  vigente; el cliente entrega el certificado correspondiente.
- Se factura electronicamente a nombre del proveedor; los datos fiscales se confirman en la
  firma.

---

## 9. Supuestos y lo que no incluye

**Para cumplir el plazo y el precio contamos con:**

1. El sistema interno que guarda la informacion y controla los cupos **ya existe y esta en
   funcionamiento**; no se modifica ni hace parte de esta propuesta.
2. Usted entrega los accesos necesarios (repositorio, dominio, cuentas de publicacion), los
   textos definitivos y las imagenes.
3. Existe un ambiente de pruebas estable; si no, acordamos un ambiente con datos de ejemplo.
4. Hay una persona de su lado autorizada para aprobar las entregas.
5. El trabajo es remoto y las reuniones de revision se agendan con 48 horas de antelacion.

**Esta propuesta no incluye:**

1. Cambios en el sistema interno: base de datos, reglas de negocio o nuevas funciones del
   servidor.
2. Las funciones de **turnos, codigos QR y control de acceso**, que aun no existen en el
   sistema interno; el panel deja el espacio preparado y activarlas se cotiza como O1.
3. Aplicaciones nativas para iPhone o Android, versiones de escritorio o widgets.
4. Costos de terceros: dominio, planes de hosting o CDN, herramientas de monitoreo, diseno
   grafico y licencias.
5. Envio de correos, mensajes de texto o WhatsApp (el sistema interno no los contempla).
6. Migracion de datos o contenidos de sistemas anteriores.
7. Idiomas distintos al espanol, salvo la opcion O4.
8. Soporte despues de las 2 semanas de acompanamiento, salvo la opcion O6.

---

## 10. Condiciones comerciales y garantias

- **Ajustes incluidos:** una ronda de ajustes menores despues de cada entrega, dentro de los
  5 dias habiles siguientes, sin costo.
- **Cambios de alcance:** se cotizan como precio fijo aparte y se ejecutan solo con su
  aprobacion escrita; no se descuentan ni se cobran horas.
- **Urgencias:** un pedido con menos de 48 horas de antelacion, o que obligue a desplazar
  otras tareas, tiene un recargo del 30% sobre el precio fijo acordado para ese cambio.
- **Garantia:** 30 dias calendario desde la aceptacion final. Corregimos sin costo cualquier
  defecto atribuible al desarrollo. No cubre cambios de alcance, errores en los contenidos que
  usted entrega, ni fallas del sistema interno o de terceros.
- **Acompanamiento posterior:** 2 semanas incluidas en D11, con respuesta en 8 horas habiles
  para incidencias criticas y 24 horas para el resto.
- **Propiedad:** el codigo y la documentacion entregados son suyos una vez pagado el total;
  conservamos la titularidad de utilidades genericas reutilizables y le otorgamos licencia
  perpetua sobre ellas.
- **Confidencialidad y datos personales:** mutua. El tratamiento de datos se rige por la Ley
  1581 de 2012 (Colombia). No usamos datos reales de participantes en los ambientes de prueba.
- **Cronograma:** 14 semanas calendario para el escenario 3, contadas desde el anticipo. Las
  demoras causadas por el cliente, el sistema interno o terceros desplazan el cierre en la
  misma proporcion, sin costo adicional para usted.
- **Cambios en el sistema interno:** si la forma en que responde el sistema interno cambia, se
  documenta y se cotiza aparte; esos ajustes se resuelven antes de la etapa que los necesite.
- **Suspension:** un pago vencido por mas de 15 dias suspende el trabajo y reprograma el
  cronograma.
- **Terminacion:** por acuerdo mutuo, pagando lo entregado y aceptado a la fecha. El anticipo
  no es reembolsable una vez iniciada la planeacion (D0).
- **Validez:** 30 dias calendario; vencida la fecha, los valores se revisan.

---

## 11. Como ajustar estas cifras

El precio es **fijo (COP $ 650.000)** y no depende del tiempo dedicado.

- **Contratar solo una parte:** sume los grupos de §3 que quiera incluir (G1 a G5) y compare
  con los escenarios de §6, que ya traen las combinaciones mas comunes.
- **Negociar el total:** si el precio global cambia, todos los valores se multiplican por el
  mismo factor (`nuevo total / 650.000`). Ejemplo con un total de 1.000.000 (factor 1,54): G1
  pasa a 209.000, G2 a 243.000 y G4 a 100.000.
- **Ajustes finos:** los valores se pueden redondear o redistribuir siempre que la suma de lo
  contratado siga dando el total acordado.
- El precio no incluye los opcionales de §5 ni los impuestos de §8.

---

## 12. Aceptacion de la propuesta

Con la firma, ambas partes aceptan el alcance, el **precio fijo de COP $ 650.000** y las
condiciones de pago descritas.

| | Cliente — Barby Toys & Cupidos | Proveedor |
| --- | --- | --- |
| Nombre | | |
| Cargo / documento | | |
| Escenario y opciones contratadas | | |
| Valor acordado (COP) | 650.000 (escenario 3) | |
| Firma | | |
| Fecha | | |

**Opciones adicionales aprobadas:** [ ] O1 [ ] O2 [ ] O3 [ ] O4 [ ] O5 [ ] O6
[ ] O7 [ ] O8 [ ] O9 — detalle: ______________________________________________

---

## Anexo A — Dedicacion estimada (referencia interna, no es un cobro por horas)

Sirve para planificar el calendario y dimensionar el trabajo. **No** es una base de
facturacion: el precio es fijo (ver §2).

| Componente | Dedicacion (h) | | Componente | Dedicacion (h) |
| --- | ---: | --- | --- | ---: |
| D0 | 16 | | D6 | 40 |
| D1 | 60 | | D7 | 64 |
| D2 | 40 | | D8 | 80 |
| D3 | 48 | | D9 | 56 |
| D4 | 56 | | D10 | 24 |
| D5 | 32 | | D11 | 40 |
| | | | **Total** | **556** |

Opcionales: O1 32 h · O2 24 h · O3 16 h · O4 24 h · O5 40 h · O6 10 h por jornada acordada ·
O7 2 h · O8 16 h · O9 por definir.

Con dedicacion parcial, las 556 h equivalen aproximadamente al plazo de 14 semanas indicado
en §1.
